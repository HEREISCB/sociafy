'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon, Pglyph } from './icons';
import { apiPatch, apiPost, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT, SHORT_TO_PLATFORM } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';
import { useSWRConfig } from 'swr';
import { InsufficientCreditsBanner } from './credits';
import { priceForImage, priceForVideo, priceForCompose, priceForAvatar, ACTION_LABELS } from '../lib/credits/pricing';
import type { CreditsPayload } from './credits';
import { VoicePicker, useVoices } from './voice-studio';

type ComposeMode = 'text' | 'image' | 'video';
type MediaKind = 'image' | 'carousel' | 'video';

const COMPOSE_PRESETS: { id: string; label: string; modes: ComposeMode[] }[] = [
  { id: 'thread',       label: 'Thread',         modes: ['text'] },
  { id: 'announcement', label: 'Announcement',   modes: ['text', 'image', 'video'] },
  { id: 'recap',        label: 'Recap',          modes: ['text', 'image'] },
  { id: 'hot-take',     label: 'Hot take',       modes: ['text', 'image'] },
  { id: 'lesson',       label: 'Lesson',         modes: ['text', 'image'] },
  { id: 'reel',         label: 'Reel script',    modes: ['video'] },
  { id: 'caption',      label: 'Image caption',  modes: ['image'] },
  { id: 'carousel',     label: 'Carousel story', modes: ['image'] },
  { id: 'hook-cta',     label: 'Hook + CTA',     modes: ['video'] },
];

// Quick-fill templates — click to drop a starter prompt + preset into the box.
// Filtered per-mode so a Text post never shows "Reel script".
const PROMPT_TEMPLATES: Array<{ label: string; prompt: string; preset: string; modes: ComposeMode[] }> = [
  { label: '🚀 Product update',  prompt: 'A product update post for [feature name]. Share what changed, who it helps, and what to do next. Keep it warm and concrete.', preset: 'announcement', modes: ['text', 'image', 'video'] },
  { label: '🧵 Thread idea',     prompt: 'A 6-tweet thread about [topic]. Hook in tweet 1, 4 specific tactics in tweets 2-5, a strong close in tweet 6.', preset: 'thread', modes: ['text'] },
  { label: '📊 Weekly recap',    prompt: 'A recap of what shipped this week: 3 wins, 1 lesson, what\'s next. Numbers where I have them.', preset: 'recap', modes: ['text', 'image'] },
  { label: '🔥 Hot take',        prompt: 'A pointed take that [conventional wisdom] is wrong because [my angle]. Stake the claim in line 1, back it with one example, end with a question.', preset: 'hot-take', modes: ['text', 'image'] },
  { label: '🎓 Lesson learned',  prompt: 'Something I learned the hard way about [topic]. What I expected, what actually happened, what I\'d tell past-me.', preset: 'lesson', modes: ['text', 'image'] },
  { label: '🎬 Reel script',     prompt: 'A 30-second reel script. Hook in the first 2 seconds, payoff with 3 quick beats, call back to the hook at the end.', preset: 'reel', modes: ['video'] },
  { label: '🖼️ Image caption',   prompt: 'A short, evocative caption to pair with my image. One-line hook, two-line context, soft CTA. No hashtag spam.', preset: 'caption', modes: ['image'] },
  { label: '🗂️ Carousel',        prompt: 'A 5-slide carousel about [topic]. Slide 1: hook. Slides 2-4: one specific point each. Slide 5: takeaway + CTA.', preset: 'carousel', modes: ['image'] },
  { label: '🎯 Hook + CTA',      prompt: 'A 15-second video hook for [topic]. First 2s: visual pattern interrupt + question. Last 2s: clear CTA.', preset: 'hook-cta', modes: ['video'] },
];

/**
 * Public failure codes from /api/media/video-job (publicVideoError in
 * app/api/v1/shared.ts) → copy the user can act on. `poll_timeout` is ours: the
 * tab gave up, the job did not.
 *
 * A content refusal must never read as a capacity problem — "try 720p" costs
 * another ~90 credits on a retry that fails identically, where "reword it" is
 * the only thing that works.
 */
const VIDEO_FAIL_COPY: Record<string, string> = {
  prompt_rejected: 'The prompt was rejected by the content filter — reword it before retrying, because the same prompt will be refused again. Credits were refunded.',
  generation_timeout: 'The clip never finished rendering. Credits were refunded — a shorter clip or 720p usually gets through.',
  storage_failed: 'The clip rendered but we could not store it. Credits were refunded — try again.',
  submit_unconfirmed: 'We never got confirmation the clip was accepted. Credits are refunded automatically — try again.',
  duplicate_request: 'That request was already running, so it was not charged twice.',
  generation_rejected: 'The request was rejected before rendering started. Credits were refunded.',
  poll_timeout: 'Still rendering after 5 minutes — it will appear in your library once it lands, and nothing extra is charged.',
};
const videoFailCopy = (code: string) => VIDEO_FAIL_COPY[code] ?? 'The clip failed to render. Credits were refunded.';

/** Mirrors REFERENCE_LIMITS.maxImages in app/api/v1/shared.ts. Not imported:
 *  that module pulls in node:dns and the database. */
const MAX_IMAGE_REFS = 4;

type Variant = { id: string; name: string; score: number; text: string; rationale?: string };

// First load starts empty — no fabricated pre-generated copy or fake scores.
// Variants populate after the user hits Generate.
const DEFAULT_VARIANTS: Variant[] = [];

type ImageSize = '1024x1024' | '1536x1024' | '1024x1536';
type ImageQuality = 'low' | 'medium' | 'high';
type VideoQuality = '480p' | '720p' | '1080p';
type VideoAspect = '9:16' | '1:1' | '16:9';
type VideoGenMode = 'text' | 'image-to-video' | 'reference' | 'audio-driven' | 'avatar';

const VIDEO_GEN_MODES: { id: VideoGenMode; label: string; sub: string; icon: 'edit' | 'image' | 'grid' | 'bolt' | 'mic' }[] = [
  { id: 'text',           label: 'Text only',       sub: 'Just a prompt',           icon: 'edit'  },
  { id: 'image-to-video', label: 'Image → video',   sub: 'Start frame + prompt',    icon: 'image' },
  { id: 'reference',      label: 'Reference',       sub: 'Up to 9 refs + a video',  icon: 'grid'  },
  { id: 'audio-driven',   label: 'Audio-driven',    sub: 'Sync motion to a track',  icon: 'bolt'  },
  { id: 'avatar',         label: 'Avatar',          sub: 'A face speaks in your voice', icon: 'mic' },
];

// Per-platform capability matrix — which modes that platform's API actually
// accepts as a primary post type. (Instagram requires media; TikTok requires
// video; YouTube text = community posts only; X allows text-only but boosts
// engagement with media.)
const PLATFORM_LIST: {
  id: string;
  label: string;
  limit: number;
  full: Platform;
  /** true means "native first-class support for this post mode". */
  supports: Record<ComposeMode, boolean>;
  /** Tooltip shown when a mode is unsupported. */
  hint: Partial<Record<ComposeMode, string>>;
  /** Mode-specific label override — e.g. YouTube becomes "YouTube Shorts" in video mode. */
  labelByMode?: Partial<Record<ComposeMode, string>>;
}[] = [
  { id: 'x',  label: 'X',         limit: 280,  full: 'x',         supports: { text: true,  image: true,  video: true  }, hint: {} },
  { id: 'li', label: 'LinkedIn',  limit: 3000, full: 'linkedin',  supports: { text: true,  image: true,  video: true  }, hint: {} },
  { id: 'fb', label: 'Facebook',  limit: 5000, full: 'facebook',  supports: { text: true,  image: true,  video: true  }, hint: {}, labelByMode: { video: 'Facebook Reels' } },
  { id: 'ig', label: 'Instagram', limit: 2200, full: 'instagram', supports: { text: false, image: true,  video: true  }, hint: { text: 'Instagram requires an image or video — switch to Image or Video mode.' }, labelByMode: { image: 'Instagram Post', video: 'Instagram Reels' } },
  { id: 'tt', label: 'TikTok',    limit: 2200, full: 'tiktok',    supports: { text: false, image: false, video: true  }, hint: { text: 'TikTok needs a video.', image: 'TikTok needs a video clip, not a single image.' } },
  // YouTube only supports video uploads via API — Community posts have no
  // public posting endpoint, so we disallow text/image entirely.
  { id: 'yt', label: 'YouTube',   limit: 5000, full: 'youtube',   supports: { text: false, image: false, video: true  }, hint: { text: 'YouTube only accepts video uploads via API. Community posts have no public endpoint.', image: 'YouTube only accepts video uploads — image posts go to Community which has no API.' }, labelByMode: { video: 'YouTube Shorts' } },
];

const MODE_CARDS: { id: ComposeMode; label: string; sub: string; icon: 'edit' | 'image' | 'play' }[] = [
  { id: 'text', label: 'Text post', sub: 'Caption-only, fastest', icon: 'edit' },
  { id: 'image', label: 'Image post', sub: 'AI image + caption', icon: 'image' },
  { id: 'video', label: 'Video post', sub: 'Upload or AI clip', icon: 'play' },
];

const IMAGE_SIZE_OPTIONS: { id: ImageSize; label: string; ratio: string }[] = [
  { id: '1024x1024', label: 'Square', ratio: '1:1' },
  { id: '1536x1024', label: 'Landscape', ratio: '3:2' },
  { id: '1024x1536', label: 'Portrait', ratio: '2:3' },
];

type PlatformMeta = (typeof PLATFORM_LIST)[number];
const PLATFORM_BY_SHORT: Record<string, PlatformMeta> = Object.fromEntries(
  PLATFORM_LIST.map((p) => [p.id, p]),
);

function platformLabel(meta: PlatformMeta, mode: ComposeMode): string {
  return meta.labelByMode?.[mode] ?? meta.label;
}

interface MediaItem {
  kind: string;
  label: string;
  tag: string;
  id?: string;
  url?: string;
  mimeType?: string;
  uploading?: boolean;
  /** CSS-friendly aspect ratio (e.g. "9/16", "1/1", "16/9"). Used by the
   * phone-preview's media area so a vertical clip doesn't get crop-fit
   * into a horizontal X/LinkedIn preview. Falls back to platform default
   * when missing (legacy uploads, stock images). */
  aspect?: string;
}

type MediaPlaceholderProps = {
  kind: string;
  ratio?: string;
  count?: number;
  url?: string;
  /** When set, the empty placeholder turns into a clickable upload affordance. */
  onUpload?: () => void;
  /** Optional second action — "Generate with AI" — shown alongside upload. */
  onGenerate?: () => void;
  /** When set + url present, clicking the filled media calls this — used to
   *  open the full-screen lightbox / video player from the phone preview. */
  onExpand?: () => void;
};

const UploadCTA: React.FC<{
  kind: string;
  onClick: () => void;
  onGenerate?: () => void;
  dark?: boolean;
}> = ({ kind, onClick, onGenerate, dark }) => {
  const label = kind === 'video' ? 'clip' : 'image';
  const fg = dark ? 'white' : 'var(--ink-2)';
  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
        color: fg, fontFamily: 'var(--mono)', fontSize: 11,
      }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: 0,
        }}
        aria-label={`Upload ${kind}`}
      >
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: dark ? 'rgba(255,255,255,0.92)' : 'var(--bg-elev)', display: 'grid', placeItems: 'center', color: 'var(--ink)' }}>
          <Icon name="upload" size={14} />
        </div>
        <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>Upload {label}</span>
      </button>
      {onGenerate && (
        <>
          <div style={{ fontSize: 9, opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.08em' }}>or</div>
          <button
            onClick={(e) => { e.stopPropagation(); onGenerate(); }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 100,
              background: dark ? 'var(--accent)' : 'var(--accent)',
              color: 'white', border: 0, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
            }}
            aria-label={`Generate ${kind} with AI`}
          >
            <Icon name="sparkle" size={11} /> Generate with AI
          </button>
        </>
      )}
    </div>
  );
};

/** Small image slot used by the video-mode anchor section (start/end frame). */
const FrameSlot: React.FC<{ label: string; url: string | null; onUpload: () => void; onClear: () => void }> = ({ label, url, onUpload, onClear }) => (
  <div>
    <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{label}</div>
    {url ? (
      <div style={{ aspectRatio: '16/9', borderRadius: 8, border: '1px solid var(--line-2)', position: 'relative', overflow: 'hidden', background: 'var(--bg-sunk)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <button
          onClick={onClear}
          style={{ position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 4, background: 'rgba(10,10,10,0.7)', color: 'white', border: 0, display: 'grid', placeItems: 'center', cursor: 'pointer' }}
          aria-label={`Clear ${label}`}
        >
          <Icon name="x" size={10} />
        </button>
      </div>
    ) : (
      <button
        onClick={onUpload}
        style={{ width: '100%', aspectRatio: '16/9', borderRadius: 8, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', color: 'var(--ink-3)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, cursor: 'pointer', fontSize: 11, fontFamily: 'var(--mono)' }}
      >
        <Icon name="upload" size={14} />
        <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 9.5 }}>Upload</span>
      </button>
    )}
  </div>
);

/**
 * Crop-to-fit modal for the avatar face photo. Locks the crop frame to the
 * chosen output aspect (9:16 / 1:1 / 16:9) so the avatar engine receives a photo
 * that already matches — no letterboxing or distortion. Drag to pan, slider to
 * zoom; on apply we render the visible frame to a canvas at the engine's tier
 * dimensions and hand back a Blob. Uses the local File (object URL) so the
 * canvas is never cross-origin-tainted.
 */
const ASPECT_WH: Record<string, { w: number; h: number; out: [number, number] }> = {
  '9:16': { w: 9, h: 16, out: [720, 1280] },
  '1:1': { w: 1, h: 1, out: [768, 768] },
  '16:9': { w: 16, h: 9, out: [1280, 720] },
};

const AvatarCropModal: React.FC<{
  file: File;
  aspect: string;
  onApply: (blob: Blob) => void;
  onUseOriginal: () => void;
  onCancel: () => void;
}> = ({ file, aspect, onApply, onUseOriginal, onCancel }) => {
  const spec = ASPECT_WH[aspect] ?? ASPECT_WH['9:16'];
  const LONG = 300;
  const [vw, vh] = spec.h >= spec.w ? [Math.round((LONG * spec.w) / spec.h), LONG] : [LONG, Math.round((LONG * spec.h) / spec.w)];

  const [src, setSrc] = useState<string>('');
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // "cover" base scale so the image always fills the frame, then user zoom on top.
  const base = nat ? Math.max(vw / nat.w, vh / nat.h) : 1;
  const scale = base * zoom;
  const dispW = nat ? nat.w * scale : 0;
  const dispH = nat ? nat.h * scale : 0;
  const maxX = Math.max(0, (dispW - vw) / 2);
  const maxY = Math.max(0, (dispH - vh) / 2);
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  const ox = clamp(off.x, maxX);
  const oy = clamp(off.y, maxY);

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, ox, oy };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setOff({ x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) });
  };
  const onUp = () => { drag.current = null; };

  const apply = () => {
    if (!nat) return;
    const [outW, outH] = spec.out;
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Frame top-left in source pixels: image is centered in the frame then panned.
    const imgLeft = vw / 2 - dispW / 2 + ox;
    const imgTop = vh / 2 - dispH / 2 + oy;
    const sx = (0 - imgLeft) / scale;
    const sy = (0 - imgTop) / scale;
    const sw = vw / scale;
    const sh = vh / scale;
    ctx.drawImage(imgRef.current!, sx, sy, sw, sh, 0, 0, outW, outH);
    canvas.toBlob((b) => { if (b) onApply(b); }, 'image/png');
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 1000 }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 14, padding: 18, width: 'min(92vw, 420px)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Crop to fit <span style={{ fontFamily: 'var(--mono)' }}>{aspect}</span></div>
        <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>Drag to reposition, slider to zoom. The avatar uses exactly this frame.</div>
        <div style={{ display: 'grid', placeItems: 'center', padding: 8, background: 'var(--bg-sunk)', borderRadius: 10 }}>
          <div
            style={{ width: vw, height: vh, position: 'relative', overflow: 'hidden', borderRadius: 8, background: '#000', cursor: 'grab', touchAction: 'none', boxShadow: '0 0 0 1px var(--line-2)' }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {src && (
              <img
                ref={imgRef} src={src} alt="crop" draggable={false}
                onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                style={{ position: 'absolute', left: '50%', top: '50%', width: dispW || 'auto', height: dispH || 'auto', transform: `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`, userSelect: 'none', pointerEvents: 'none', maxWidth: 'none' }}
              />
            )}
          </div>
        </div>
        <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" style={{ width: '100%' }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="btn sm ghost" onClick={onCancel}>Cancel</button>
          <button className="btn sm ghost" onClick={onUseOriginal} title="Upload the photo without cropping">Use original</button>
          <button className="btn sm" onClick={apply} disabled={!nat}>Apply crop</button>
        </div>
      </div>
    </div>
  );
};

const MediaPlaceholder: React.FC<MediaPlaceholderProps> = ({ kind, ratio = '16/9', count = 1, url, onUpload, onGenerate, onExpand }) => {
  if (kind === 'video') {
    if (url) {
      return (
        <div
          style={{ aspectRatio: ratio, position: 'relative', background: '#000', overflow: 'hidden', cursor: onExpand ? 'zoom-in' : 'default' }}
          onClick={onExpand}
          role={onExpand ? 'button' : undefined}
          aria-label={onExpand ? 'Play video full-screen' : undefined}
        >
          <video src={url} muted loop playsInline style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(255,255,255,0.92)', color: 'var(--ink)', display: 'grid', placeItems: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
              <Icon name="play" size={16} />
            </div>
          </div>
        </div>
      );
    }
    return (
      <div style={{ aspectRatio: ratio, position: 'relative', background: 'repeating-linear-gradient(135deg, #181818 0 6px, #232323 6px 12px)', overflow: 'hidden' }}>
        {onUpload ? (
          <UploadCTA kind="video" onClick={onUpload} onGenerate={onGenerate} dark />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.92)', color: 'var(--ink)', display: 'grid', placeItems: 'center' }}>
              <Icon name="play" size={14} />
            </div>
          </div>
        )}
      </div>
    );
  }
  if (url) {
    return (
      <div
        style={{ aspectRatio: ratio, position: 'relative', background: 'var(--bg-sunk)', overflow: 'hidden', cursor: onExpand ? 'zoom-in' : 'default' }}
        onClick={onExpand}
        role={onExpand ? 'button' : undefined}
        aria-label={onExpand ? 'View image full-screen' : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="post media" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
        {count > 1 && <span style={{ position: 'absolute', top: 6, right: 6, fontFamily: 'var(--mono)', fontSize: 9.5, background: 'rgba(0,0,0,0.7)', color: 'white', padding: '1px 5px', borderRadius: 3 }}>1/{count}</span>}
      </div>
    );
  }
  return (
    <div style={{ aspectRatio: ratio, position: 'relative', background: 'repeating-linear-gradient(45deg, var(--bg-sunk), var(--bg-sunk) 8px, var(--bg) 8px, var(--bg) 16px)', overflow: 'hidden' }}>
      {onUpload ? (
        <UploadCTA kind="image" onClick={onUpload} onGenerate={onGenerate} />
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <Icon name="image" size={20} style={{ color: 'var(--ink-4)' }} />
        </div>
      )}
      {count > 1 && <span style={{ position: 'absolute', top: 6, right: 6, fontFamily: 'var(--mono)', fontSize: 9.5, background: 'rgba(0,0,0,0.7)', color: 'white', padding: '1px 5px', borderRadius: 3 }}>1/{count}</span>}
    </div>
  );
};

type Author = {
  /** Display name — falls back to "You" if missing. */
  name: string;
  /** Username / handle — without the @ prefix. Falls back to undefined. */
  handle?: string;
  /** Avatar URL — falls back to a colored gradient if missing. */
  avatar?: string;
  /** Subtitle / headline — currently only LinkedIn uses this. */
  headline?: string;
};

type PostProps = { text: string; mediaKind: string; mediaUrl?: string; onUpload?: () => void; onGenerate?: () => void; author: Author; mediaAspect?: string; onExpand?: () => void };

/** Initials for the gradient-avatar fallback. */
function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '·';
}

const AvatarCircle: React.FC<{ author: Author; size: number; gradient?: string }> = ({ author, size, gradient }) => {
  if (author.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={author.avatar}
        alt={author.name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, display: 'block' }}
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div
      style={{
        width: size, height: size, borderRadius: '50%',
        background: gradient ?? 'linear-gradient(135deg, var(--accent), oklch(0.62 0.18 30))',
        flexShrink: 0, display: 'grid', placeItems: 'center',
        color: 'white', fontWeight: 600, fontSize: Math.round(size * 0.4),
      }}
    >
      {initialsOf(author.name)}
    </div>
  );
};

const PostX: React.FC<PostProps> = ({ text, mediaKind, mediaUrl, onUpload, onGenerate, author, mediaAspect, onExpand }) => (
  <div style={{ padding: '12px 14px', borderTop: '1px solid var(--line)' }}>
    <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
      <AvatarCircle author={author} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span>{author.name}</span>
          {author.handle && <span style={{ color: 'var(--ink-4)', fontWeight: 400, fontSize: 12.5 }}>@{author.handle}</span>}
          <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>· now</span>
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.4, marginTop: 4, whiteSpace: 'pre-wrap', color: 'var(--ink)' }}>{text}</div>
        {mediaKind && (
          <div style={{ marginTop: 8, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)' }}>
            <MediaPlaceholder kind={mediaKind} ratio={mediaAspect ?? '16/9'} url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} onExpand={onExpand} />
          </div>
        )}
      </div>
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--ink-4)', fontSize: 11, marginLeft: 46, fontFamily: 'var(--mono)' }}>
      <span>♡ —</span><span>↻ —</span><span>💬 —</span><span>↗ —</span>
    </div>
  </div>
);

const PostLI: React.FC<PostProps> = ({ text, mediaKind, mediaUrl, onUpload, onGenerate, author, mediaAspect, onExpand }) => (
  <div style={{ padding: '12px 14px' }}>
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <AvatarCircle author={author} size={36} gradient="linear-gradient(135deg, var(--li), #003B82)" />
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{author.name}</div>
        {author.headline && <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{author.headline}</div>}
        <div style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>now · 🌐</div>
      </div>
    </div>
    <div style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--ink-2)' }}>{text}</div>
    {mediaKind && <div style={{ marginTop: 10 }}><MediaPlaceholder kind={mediaKind} ratio={mediaAspect ?? '16/9'} url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} onExpand={onExpand} /></div>}
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 8, display: 'flex', justifyContent: 'space-around', fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
      <span>👍 Like</span><span>💬 Comment</span><span>↻ Repost</span><span>↗ Send</span>
    </div>
  </div>
);

const PostIG: React.FC<{ text: string; mediaKind: string; mediaCount: number; mediaUrl?: string; onUpload?: () => void; onGenerate?: () => void; author: Author; mediaAspect?: string; onExpand?: () => void }> = ({ text, mediaKind, mediaCount, mediaUrl, onUpload, onGenerate, author, mediaAspect, onExpand }) => {
  const handle = (author.handle ?? author.name).toLowerCase().replace(/\s+/g, '');
  return (
    <div>
      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--line)' }}>
        <AvatarCircle author={author} size={28} gradient="linear-gradient(135deg, var(--ig), #FCAF45)" />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{handle}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--ink-4)' }}>•••</span>
      </div>
      <MediaPlaceholder kind={mediaKind || 'image'} ratio={mediaAspect ?? '1/1'} count={mediaKind === 'carousel' ? mediaCount : 1} url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} onExpand={onExpand} />
      <div style={{ padding: '8px 12px', display: 'flex', gap: 14, fontSize: 16 }}>
        <span>♡</span><span>💬</span><span>↗</span>
        <span style={{ marginLeft: 'auto' }}>⊟</span>
      </div>
      <div style={{ padding: '0 12px 12px', fontSize: 11.5, lineHeight: 1.4, color: 'var(--ink-2)' }}>
        <strong style={{ fontWeight: 600 }}>{handle}</strong> {text.slice(0, 110)}…
      </div>
    </div>
  );
};

const PostFB: React.FC<PostProps> = ({ text, mediaKind, mediaUrl, onUpload, onGenerate, author, mediaAspect, onExpand }) => (
  <div style={{ padding: '12px 14px' }}>
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <AvatarCircle author={author} size={36} gradient="var(--fb)" />
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{author.name}</div>
        <div style={{ fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>Just now · 🌐</div>
      </div>
    </div>
    <div style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: mediaKind ? 10 : 0 }}>{text}</div>
    {mediaKind && <MediaPlaceholder kind={mediaKind} ratio={mediaAspect ?? '4/3'} url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} onExpand={onExpand} />}
  </div>
);

const PostTT: React.FC<{ text: string; mediaUrl?: string; onUpload?: () => void; onGenerate?: () => void; author: Author; mediaAspect?: string; onExpand?: () => void }> = ({ text, mediaUrl, onUpload, onGenerate, author, mediaAspect, onExpand }) => {
  const handle = (author.handle ?? author.name).toLowerCase().replace(/\s+/g, '');
  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', aspectRatio: mediaAspect ?? '9/16', background: '#000', cursor: mediaUrl && onExpand ? 'zoom-in' : 'default' }}
      onClick={mediaUrl && onExpand ? onExpand : undefined}
      role={mediaUrl && onExpand ? 'button' : undefined}
      aria-label={mediaUrl && onExpand ? 'Play video full-screen' : undefined}
    >
      {mediaUrl ? (
        <video src={mediaUrl} muted loop autoPlay playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : onUpload ? (
        <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, #111 0 8px, #181818 8px 16px)' }}>
          <UploadCTA kind="video" onClick={onUpload} onGenerate={onGenerate} dark />
        </div>
      ) : (
        <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, #111 0 8px, #181818 8px 16px)', display: 'grid', placeItems: 'center', color: '#fff8', fontFamily: 'var(--mono)', fontSize: 11 }}>
          [ vertical video ]
        </div>
      )}
      <div style={{ position: 'absolute', bottom: '12%', left: '4%', right: '18%', color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.5)', pointerEvents: 'none' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>@{handle}</div>
        <div style={{ fontSize: 11.5, lineHeight: 1.4, whiteSpace: 'pre-wrap', opacity: 0.95 }}>{text.slice(0, 90)}…</div>
      </div>
    </div>
  );
};

const PostYT: React.FC<PostProps> = ({ text, mediaKind, mediaUrl, onUpload, onGenerate, author, mediaAspect, onExpand }) => (
  <div>
    {mediaKind === 'video' ? (
      <div
        style={{ aspectRatio: mediaAspect ?? '9/16', background: '#000', position: 'relative', overflow: 'hidden', cursor: mediaUrl && onExpand ? 'zoom-in' : 'default' }}
        onClick={mediaUrl && onExpand ? onExpand : undefined}
        role={mediaUrl && onExpand ? 'button' : undefined}
      >
        {mediaUrl ? (
          <video src={mediaUrl} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : onUpload ? (
          <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, #111 0 8px, #181818 8px 16px)' }}>
            <UploadCTA kind="video" onClick={onUpload} onGenerate={onGenerate} dark />
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, #111 0 8px, #181818 8px 16px)' }} />
        )}
        <span style={{ position: 'absolute', top: 8, left: 8, fontSize: 10, fontWeight: 700, padding: '3px 6px', background: 'rgba(255,255,255,0.15)', color: 'white', borderRadius: 4 }}>SHORTS</span>
        <div style={{ position: 'absolute', bottom: 8, left: 8, color: '#fff', fontSize: 11, fontWeight: 600, textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>@{(author.handle ?? author.name).toLowerCase().replace(/\s+/g, '')}</div>
      </div>
    ) : (
      <div style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <AvatarCircle author={author} size={28} gradient="#FF0000" />
          <div style={{ fontSize: 12, fontWeight: 600 }}>{author.name} <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>· Community</span></div>
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: mediaKind ? 8 : 0 }}>{text}</div>
        {mediaKind === 'image' && <MediaPlaceholder kind="image" ratio={mediaAspect ?? '16/9'} url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} onExpand={onExpand} />}
      </div>
    )}
  </div>
);

const PhonePreview: React.FC<{ platform: string; text: string; mediaKind: string; mediaCount: number; mediaUrl?: string; onUpload?: () => void; onGenerate?: () => void; author: Author; mediaAspect?: string; onExpand?: () => void }> = ({ platform, text, mediaKind, mediaCount, mediaUrl, onUpload, onGenerate, author, mediaAspect, onExpand }) => (
  <div className="phone">
    <div className="phone-screen">
      <div className="phone-statusbar">
        <span>9:41</span>
        <div className="icons"><span>•••</span><span>◊</span><span>▮</span></div>
      </div>
      {platform === 'x' && <PostX text={text} mediaKind={mediaKind} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} mediaAspect={mediaAspect} onExpand={onExpand} />}
      {platform === 'li' && <PostLI text={text} mediaKind={mediaKind} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} mediaAspect={mediaAspect} onExpand={onExpand} />}
      {platform === 'ig' && <PostIG text={text} mediaKind={mediaKind} mediaCount={mediaCount} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} mediaAspect={mediaAspect} onExpand={onExpand} />}
      {platform === 'fb' && <PostFB text={text} mediaKind={mediaKind} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} mediaAspect={mediaAspect} onExpand={onExpand} />}
      {platform === 'tt' && <PostTT text={text} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} mediaAspect={mediaAspect} onExpand={onExpand} />}
      {platform === 'yt' && <PostYT text={text} mediaKind={mediaKind} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} mediaAspect={mediaAspect} onExpand={onExpand} />}
    </div>
  </div>
);

type Account = {
  id: string;
  platform: Platform;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

interface ComposeProps {
  draftId?: string | null;
  onDone?: () => void;
}

const Compose: React.FC<ComposeProps> = ({ draftId, onDone }) => {
  const [mode, setMode] = useState<ComposeMode>('text');
  const [withResearch, setWithResearch] = useState<boolean>(false);
  const [prompt, setPrompt] = useState('');
  const [preset, setPreset] = useState('announcement');
  const [active, setActive] = useState('B');
  const [platforms, setPlatforms] = useState<string[]>(['x', 'li']);
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);
  const [draftSource, setDraftSource] = useState<'user' | 'agent'>('user');
  const [previewPlat, setPreviewPlat] = useState('x');
  const [generating, setGenerating] = useState(false);
  const [variants, setVariants] = useState<Variant[]>(DEFAULT_VARIANTS);
  const [perPlatform, setPerPlatform] = useState<Partial<Record<Platform, string>>>({});
  const [mediaKind, setMediaKind] = useState<MediaKind>('image');
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState<null | 'schedule' | 'post'>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [customSchedule, setCustomSchedule] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Anchor for auto-scroll after a generation lands so the user
   *  doesn't have to scroll down to find their image / video. */
  const generatedMediaRef = useRef<HTMLDivElement | null>(null);
  /** Insufficient-credits banner state — set when any AI route returns 402. */
  const [creditError, setCreditError] = useState<{ balance: number; needed: number } | null>(null);
  const { mutate: swrMutate } = useSWRConfig();
  /** Tell the credit-meter (and any /usage tab) to refetch. Call after any
   *  AI route resolves so the user sees their balance update instantly. */
  const refreshCredits = () => { swrMutate('/api/credits'); };
  /** Live credit balance for cost-preview pills. Polls every 30s in the
   *  background; refreshed on demand via refreshCredits. */
  const { data: credits } = useApi<CreditsPayload>('/api/credits', { refreshInterval: 30_000 });
  const balance = credits?.balance ?? 0;
  /** Insufficient-credits derived from the cost preview vs. balance. Used
   *  to disable the generate button + show an inline danger note. */
  const [previewCost, setPreviewCost] = useState<{ credits: number; label: string; action: string } | null>(null);

  // Image generation state
  const [imageSize, setImageSize] = useState<ImageSize>('1024x1024');
  const [imageQuality, setImageQuality] = useState<ImageQuality>('medium');
  const [imageCount, setImageCount] = useState<number>(2);
  const [imageBusy, setImageBusy] = useState(false);
  const [autoEnhance, setAutoEnhance] = useState<boolean>(true);
  /** Images the generation should imitate — picked from the gallery below, so
   *  there is no second upload flow. Priced by priceForImage, flat per ref. */
  const [imageRefUrls, setImageRefUrls] = useState<string[]>([]);
  const toggleImageRef = (url: string) => {
    if (imageRefUrls.includes(url)) { setImageRefUrls((c) => c.filter((u) => u !== url)); return; }
    if (imageRefUrls.length >= MAX_IMAGE_REFS) {
      setToast(`Up to ${MAX_IMAGE_REFS} reference images — remove one first.`);
      return;
    }
    setImageRefUrls((c) => [...c, url]);
  };

  // Video generation state.
  const [videoCount, setVideoCount] = useState<number>(1);
  const [videoDuration, setVideoDuration] = useState<number>(8);
  const [videoQuality, setVideoQuality] = useState<VideoQuality>('720p');
  // seedance-2-fast is the recommended default (COSTS.md): ~20% cheaper for the
  // same resolution. Quality stays one click away.
  const [videoFast, setVideoFast] = useState<boolean>(true);
  const [videoAspect, setVideoAspect] = useState<VideoAspect>('9:16');
  // seedance-2-fast has no 1080p variant, so 1080p always means Quality — both
  // pricing and the provider call have to agree on that.
  const effectiveFast = videoFast && videoQuality !== '1080p';
  const [videoBusy, setVideoBusy] = useState(false);
  // Generation type picker + all the possible anchors.
  const [videoGenMode, setVideoGenMode] = useState<VideoGenMode>('text');
  const [startFrameUrl, setStartFrameUrl] = useState<string | null>(null);
  const [endFrameUrl, setEndFrameUrl] = useState<string | null>(null);
  const [referenceImageUrls, setReferenceImageUrls] = useState<string[]>([]);
  const [referenceVideoUrl, setReferenceVideoUrl] = useState<string | null>(null);
  // Server-probed length of the reference clip (from the upload row, not the
  // browser) — drives the surcharge shown in the cost preview. null = the
  // server couldn't read it, and it will reject the generation.
  const [refVideoSec, setRefVideoSec] = useState<number | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // Avatar mode: a face photo + a script spoken in a Voice Twin (or uploaded audio).
  const [avatarImageUrl, setAvatarImageUrl] = useState<string | null>(null);
  // Avatar face crop: keep the local File so the user can (re)crop to the chosen
  // aspect — cropping a fresh File avoids cross-origin canvas tainting.
  const [avatarFaceFile, setAvatarFaceFile] = useState<File | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [avatarScript, setAvatarScript] = useState<string>('');
  const [avatarVoiceId, setAvatarVoiceId] = useState<string | null>(null);
  const [avatarAudioMode, setAvatarAudioMode] = useState<'voice' | 'audio'>('voice');
  // Inline validation flag — set when an avatar generate attempt is missing
  // inputs, so we can highlight the specific control instead of only toasting.
  const [avatarTouched, setAvatarTouched] = useState(false);
  // Voice preview (hear the cloned voice say the script before committing to a video).
  const [voicePreviewBusy, setVoicePreviewBusy] = useState(false);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState<string | null>(null);
  const { voices: myVoices } = useVoices();
  const refUploadRef = useRef<HTMLInputElement | null>(null);
  type AnchorTarget = 'start' | 'end' | 'reference' | 'refVideo' | 'audio' | 'avatarFace';
  const [refUploadTarget, setRefUploadTarget] = useState<AnchorTarget | null>(null);

  /** Uploads and returns the media_assets row (durationS included — the video
   *  cost preview needs the server's number, not one measured in the browser). */
  const uploadAnchor = async (file: File): Promise<{ publicUrl: string; durationS: string | null } | null> => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('label', `anchor-${file.name}`);
    const r = await fetch('/api/media/upload', { method: 'POST', body: fd, credentials: 'include' });
    if (!r.ok) {
      setToast(r.status === 503 ? 'Storage not configured.' : `Upload failed: ${r.status}`);
      return null;
    }
    return r.json();
  };

  const onPickFrame = (target: AnchorTarget) => {
    setRefUploadTarget(target);
    // Drive the file-picker's accept attribute via the target — easier than
    // juggling three hidden inputs.
    if (refUploadRef.current) {
      refUploadRef.current.accept = target === 'audio'
        ? 'audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm,audio/m4a,audio/x-m4a,audio/aac'
        : target === 'refVideo'
          ? 'video/mp4,video/webm,video/quicktime'
          : 'image/png,image/jpeg,image/webp';
      // 'avatarFace' shares the image accept set above (falls through to else).
      refUploadRef.current.click();
    }
  };

  const onFrameChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = refUploadTarget;
    e.target.value = '';
    if (!file || !target) return;
    // Avatar face: don't upload raw — open the crop-to-aspect modal first.
    if (target === 'avatarFace') {
      setAvatarFaceFile(file);
      setCropOpen(true);
      setRefUploadTarget(null);
      return;
    }
    const row = await uploadAnchor(file);
    if (!row) return;
    const url = row.publicUrl;
    if (target === 'start') setStartFrameUrl(url);
    else if (target === 'end') setEndFrameUrl(url);
    else if (target === 'refVideo') {
      setReferenceVideoUrl(url);
      const secs = row.durationS != null ? Number(row.durationS) : NaN;
      setRefVideoSec(Number.isFinite(secs) && secs > 0 ? secs : null);
    }
    else if (target === 'audio') setAudioUrl(url);
    else setReferenceImageUrls((cur) => [...cur, url].slice(0, 9));
    setRefUploadTarget(null);
  };

  /** Upload a (possibly cropped) avatar face image and set it as the photo. */
  const applyAvatarFace = async (data: Blob) => {
    const file = data instanceof File ? data : new File([data], 'avatar-face.png', { type: data.type || 'image/png' });
    const row = await uploadAnchor(file);
    if (row) { setAvatarImageUrl(row.publicUrl); setAvatarTouched(false); }
    setCropOpen(false);
  };

  /** The media item the user has marked as the "hero" for the preview. */
  const [selectedMediaIdx, setSelectedMediaIdx] = useState<number>(0);

  /** Success modal after a publish lands. null = closed. */
  const [publishedModal, setPublishedModal] = useState<null | {
    ok: Array<{ platform: string; url?: string | null }>;
    failed: Array<{ platform: string; error?: string }>;
  }>(null);

  // Recompute the credit cost preview whenever inputs change. Renders in the
  // strip under the prompt + pills onto the generate button so the user
  // always knows what each click will cost.
  useEffect(() => {
    if (mode === 'image') {
      // References carry a flat surcharge each, folded into `unit` by the same
      // helper the server prices with — so the pill is what gets charged.
      const { credits: unit, action } = priceForImage(imageSize, imageQuality, imageRefUrls.length);
      const total = unit * imageCount;
      const refs = imageRefUrls.length;
      setPreviewCost({
        credits: total,
        action,
        label: refs ? `${ACTION_LABELS[action]} + ${refs} reference${refs === 1 ? '' : 's'}` : ACTION_LABELS[action],
      });
    } else if (mode === 'video' && videoGenMode === 'avatar') {
      const q = videoQuality === '1080p' ? '720p' : videoQuality;
      const per = priceForAvatar(q);
      setPreviewCost({ credits: per.credits, action: per.action, label: ACTION_LABELS[per.action] });
    } else if (mode === 'video') {
      // Mirror the server: a reference video adds a per-input-second surcharge
      // and forces count to 1, so the preview matches what gets charged.
      const refSec = videoGenMode === 'reference' ? refVideoSec : null;
      const per = priceForVideo({
        durationSec: videoDuration, quality: videoQuality, fast: effectiveFast,
        inputDurationSec: refSec ?? undefined,
      });
      const total = per.credits * (refSec ? 1 : videoCount);
      setPreviewCost({ credits: total, action: per.action, label: ACTION_LABELS[per.action] });
    } else {
      // Text post: 1 credit, or 6 + maybe extra searches if research is on.
      const p = priceForCompose({ withTools: withResearch, extraSearches: 0 });
      setPreviewCost({ credits: p.credits, action: p.action, label: ACTION_LABELS[p.action] });
    }
  }, [mode, imageSize, imageQuality, imageCount, imageRefUrls, videoDuration, videoQuality, videoCount, videoGenMode, effectiveFast, refVideoSec, withResearch]);

  /** Full-screen media preview. null = closed. Handles both images and videos. */
  const [lightbox, setLightbox] = useState<{ url: string; label?: string; kind?: 'image' | 'video' } | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Stock image picker state
  const [stockOpen, setStockOpen] = useState(false);
  const [stockQuery, setStockQuery] = useState('');
  const [stockResults, setStockResults] = useState<Array<{ id: string; description: string | null; url: string; thumb: string; attribution: string | null; source: string }>>([]);
  const [stockLoading, setStockLoading] = useState(false);

  const runStockSearch = async (q: string) => {
    if (!q.trim()) return;
    setStockLoading(true);
    try {
      const r = await fetch(`/api/media/search?q=${encodeURIComponent(q)}&limit=8`, { credentials: 'include' });
      if (!r.ok) {
        setToast(r.status === 429 ? 'Slow down — too many image searches.' : `Image search failed: ${r.status}`);
        setStockResults([]);
        return;
      }
      const data = (await r.json()) as { results: typeof stockResults };
      setStockResults(data.results);
    } catch {
      setToast('Image search failed.');
    } finally {
      setStockLoading(false);
    }
  };

  const pickStockImage = (img: { url: string; thumb: string; description: string | null; source: string }) => {
    setMedia((m) => [...m, {
      kind: 'image',
      label: img.description?.slice(0, 60) || 'Stock image',
      tag: img.source,
      url: img.url,
      mimeType: 'image/jpeg',
    }]);
    setStockOpen(false);
    setStockResults([]);
    setStockQuery('');
  };

  const onPickFile = () => fileInputRef.current?.click();
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // allow re-uploading the same file
    const tempId = `tmp-${Date.now()}`;
    setMedia((m) => [...m, { kind: file.type.startsWith('video/') ? 'video' : 'image', label: file.name, tag: 'Uploading', uploading: true, id: tempId }]);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('label', file.name);
      const r = await fetch('/api/media/upload', { method: 'POST', body: fd, credentials: 'include' });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        setMedia((m) => m.filter((it) => it.id !== tempId));
        if (r.status === 503) setToast('R2 not configured yet — set the R2 env vars in SETUP.md.');
        else if (r.status === 401) setToast('Sign in to upload media.');
        else setToast(`Upload failed: ${detail || r.status}`);
        return;
      }
      const row = await r.json();
      setMedia((m) =>
        m.map((it) =>
          it.id === tempId
            ? { kind: row.mimeType.startsWith('video/') ? 'video' : 'image', label: row.label || file.name, tag: 'Uploaded', id: row.id, url: row.publicUrl, mimeType: row.mimeType }
            : it,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMedia((m) => m.filter((it) => it.id !== tempId));
      setToast(`Upload failed: ${msg}`);
    }
  };

  // Keep the media-kind tab in sync with the top-level mode so previews adapt.
  useEffect(() => {
    if (mode === 'image') setMediaKind('image');
    else if (mode === 'video') setMediaKind('video');
  }, [mode]);

  // If the active preset isn't valid for the current mode, drop to the first
  // one that is. Keeps the AI's format hint from going stale.
  useEffect(() => {
    const valid = COMPOSE_PRESETS.find((p) => p.id === preset)?.modes.includes(mode);
    if (!valid) {
      const next = COMPOSE_PRESETS.find((p) => p.modes.includes(mode));
      if (next) setPreset(next.id);
    }
  }, [mode, preset]);

  const generateImage = async () => {
    const p = prompt.trim();
    if (!p) {
      setToast('Add a post topic first — it drives the image too.');
      return;
    }
    setImageBusy(true);
    setToast(autoEnhance ? 'Enhancing prompt + generating…' : 'Generating…');
    try {
      const r = await fetch('/api/media/generate-image', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: p,
          size: imageSize,
          quality: imageQuality,
          count: imageCount,
          caption: variant?.text?.slice(0, 600),
          rawPrompt: !autoEnhance,
          referenceImageUrls: imageRefUrls.length ? imageRefUrls : undefined,
        }),
      });
      if (!r.ok) {
        // Try to read a structured error from the response so the user gets a
        // real hint instead of a bare status code. The new generate-image
        // route returns { error, hint, detail } for network failures.
        const body = await r.json().catch(() => ({} as { error?: string; hint?: string; message?: string; detail?: string; balance?: number; needed?: number }));
        if (r.status === 402 && body?.error === 'insufficient_credits') {
          setCreditError({ balance: Number(body.balance ?? 0), needed: Number(body.needed ?? 0) });
          setToast(null);
          refreshCredits();
          return;
        }
        if (r.status === 503) setToast('Image generation isn\'t configured yet. Check your AI + storage settings.');
        else if (r.status === 429) setToast('Slow down — too many image generations. Try again shortly.');
        else if (r.status === 401) setToast('Sign in to generate images.');
        else if (body?.error === 'upstream_network_error') {
          setToast(body.hint ?? 'Your network blocked the image provider — antivirus or proxy is likely intercepting TLS.');
        }
        // Reference rejections come back in the shared `{ error, message }`
        // envelope and each message says exactly which URL and why.
        else if (body?.hint || body?.message) setToast(body.hint ?? body.message!);
        else setToast(`Image generation failed: ${r.status}${body?.detail ? ` · ${body.detail.slice(0, 140)}` : ''}`);
        return;
      }
      const data = (await r.json()) as {
        items: Array<{ id: string; publicUrl: string; mimeType: string; label?: string }>;
        rewrittenPrompt?: string;
        enhanced?: boolean;
      };
      const imageAspect = imageSize.replace('x', '/');
      const added: MediaItem[] = data.items.map((row) => ({
        kind: 'image',
        label: row.label || p.slice(0, 60),
        tag: data.enhanced ? 'AI ✨' : 'AI',
        id: row.id,
        url: row.publicUrl,
        mimeType: row.mimeType,
        aspect: imageAspect,
      }));
      setMedia((m) => [...m, ...added]);
      setCreditError(null);
      refreshCredits();
      // Auto-select the first newly generated image as hero
      setSelectedMediaIdx((modeMedia.length) + (mode === 'image' ? 0 : 0));
      setToast(
        data.enhanced
          ? `Generated ${added.length} · enhanced prompt: "${(data.rewrittenPrompt ?? '').slice(0, 90)}${(data.rewrittenPrompt ?? '').length > 90 ? '…' : ''}"`
          : `Generated ${added.length} image${added.length === 1 ? '' : 's'}.`,
      );
      // Pull the freshly-rendered media card into view so the user
      // sees the result without scrolling.
      setTimeout(() => {
        generatedMediaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(`Image generation failed: ${msg}`);
    } finally {
      setImageBusy(false);
    }
  };

  const generateVideo = async () => {
    const p = prompt.trim();
    if (!p) {
      setToast('Add a post topic first — it drives the video too.');
      return;
    }
    setVideoBusy(true);
    setToast(autoEnhance ? 'Enhancing prompt + queueing video…' : 'Queueing video…');
    try {
      const r = await fetch('/api/media/generate-video', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: p,
          durationSec: videoDuration,
          quality: videoQuality,
          aspect: videoAspect,
          count: videoCount,
          caption: variant?.text?.slice(0, 600),
          rawPrompt: !autoEnhance,
          fast: effectiveFast,
          genMode: videoGenMode,
          startFrameUrl: startFrameUrl ?? undefined,
          endFrameUrl: endFrameUrl ?? undefined,
          referenceImageUrls: referenceImageUrls.length ? referenceImageUrls : undefined,
          referenceVideoUrl: referenceVideoUrl ?? undefined,
          audioUrl: audioUrl ?? undefined,
        }),
      });
      const data = await r.json().catch(() => ({} as Record<string, unknown>));
      if (r.status === 402 && (data as { error?: string })?.error === 'insufficient_credits') {
        const body = data as { balance?: number; needed?: number };
        setCreditError({ balance: Number(body.balance ?? 0), needed: Number(body.needed ?? 0) });
        setToast(null);
        refreshCredits();
        return;
      }
      if (r.status === 503 && (data as { error?: string })?.error === 'video_provider_not_configured') {
        setToast('AI video isn\'t configured yet. Add PIAPI_API_KEY to .env.local.');
        return;
      }
      if (!r.ok && r.status !== 202) {
        if (r.status === 429) setToast('Slow down — too many video generations. Try again shortly.');
        else if (r.status === 401) setToast('Sign in to generate videos.');
        else if (r.status === 400 && ((data as { hint?: string }).hint || (data as { message?: string }).message)) {
          // Reference rejections (a URL we refuse to fetch, a clip that is too
          // long or whose length we can't read) carry an actionable message —
          // show it rather than a bare status code. `message` is the shared
          // envelope fetchReferenceImages answers with.
          setToast((data as { hint?: string; message?: string }).hint ?? (data as { message: string }).message);
        }
        else {
          const detail = (data as { detail?: string }).detail;
          setToast(`Video generation failed: ${r.status}${detail ? ` · ${detail.slice(0, 140)}` : ''}`);
        }
        return;
      }
      setCreditError(null);
      refreshCredits();

      const submitData = data as {
        jobs?: Array<{ id: string; providerTaskId: string }>;
        rewrittenPrompt?: string;
        enhanced?: boolean;
      };
      const jobs = submitData.jobs ?? [];
      if (jobs.length === 0) {
        setToast('Video queue returned no jobs.');
        return;
      }

      setToast(
        submitData.enhanced
          ? `Queued ${jobs.length} · enhanced prompt: "${(submitData.rewrittenPrompt ?? '').slice(0, 90)}…" — rendering, ~30–120s`
          : `Queued ${jobs.length} video${jobs.length === 1 ? '' : 's'} — rendering, ~30–120s`,
      );

      // Poll each job in parallel. PiAPI Seedance typically resolves in
      // 30–120s; we cap at 5 minutes and back off slightly over time.
      // Resolves to the clip, or to why this specific job didn't produce one —
      // one blanket message for every kind of failure is what sent users off
      // retrying a content refusal at a lower resolution.
      const pollOne = async (jobId: string): Promise<MediaItem | { failed: string }> => {
        const startedAt = Date.now();
        const maxMs = 5 * 60_000;
        let interval = 4_000;
        while (Date.now() - startedAt < maxMs) {
          await new Promise((res) => setTimeout(res, interval));
          interval = Math.min(interval + 500, 8_000);
          let pr: Response;
          try {
            pr = await fetch(`/api/media/video-job/${jobId}`, { credentials: 'include' });
          } catch { continue; }
          if (!pr.ok) continue;
          const pd = await pr.json().catch(() => ({} as Record<string, unknown>)) as {
            status?: 'pending' | 'completed' | 'failed';
            asset?: { id: string; publicUrl: string; mimeType: string; label?: string };
            error?: string;
          };
          if (pd.status === 'completed' && pd.asset) {
            return {
              kind: 'video',
              label: pd.asset.label || p.slice(0, 60),
              tag: submitData.enhanced ? 'AI ✨' : 'AI',
              id: pd.asset.id,
              url: pd.asset.publicUrl,
              mimeType: pd.asset.mimeType,
              aspect: videoAspect.replace(':', '/'),
            };
          }
          if (pd.status === 'failed') {
            // pd.error is a public code, mapped server-side — never the
            // provider's own text.
            console.warn('[generateVideo] job failed:', jobId, pd.error);
            return { failed: pd.error || 'generation_failed' };
          }
        }
        // We stopped watching; the job may still land via the cron sweeper.
        console.warn('[generateVideo] job timed out:', jobId);
        return { failed: 'poll_timeout' };
      };

      const settled = await Promise.all(jobs.map((j) => pollOne(j.id)));
      const added = settled.filter((m): m is MediaItem => !('failed' in m));
      const failed = settled.filter((m): m is { failed: string } => 'failed' in m);
      // Refresh credits — refunds may have landed for failed jobs.
      refreshCredits();
      if (added.length > 0) {
        setMedia((m) => [...m, ...added]);
        setTimeout(() => {
          generatedMediaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
      }
      if (failed.length === 0) {
        setToast(`Generated ${added.length} video${added.length === 1 ? '' : 's'}.`);
      } else {
        // One line per distinct reason: a moderation refusal and a timeout ask
        // opposite things of the user, so they must not be merged.
        const reasons = [...new Set(failed.map((f) => f.failed))].map(videoFailCopy);
        setToast([added.length ? `Generated ${added.length} of ${jobs.length}.` : null, ...reasons].filter(Boolean).join(' '));
      }
      setTimeout(() => setToast(null), failed.length ? 12_000 : 5_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(`Video generation failed: ${msg}`);
    } finally {
      setVideoBusy(false);
    }
  };

  /** Synthesize the script in the selected Voice Twin and play it back, so the
   *  user can hear the voice before generating the (slow, costly) video. */
  const previewVoice = async () => {
    if (!(avatarVoiceId && avatarScript.trim())) {
      setToast('Pick a voice and type a script to preview.');
      return;
    }
    setVoicePreviewBusy(true);
    setVoicePreviewUrl(null);
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voiceId: avatarVoiceId, text: avatarScript.trim().slice(0, 600) }),
      });
      const data = await r.json().catch(() => ({} as Record<string, unknown>));
      if (r.status === 402 && (data as { error?: string })?.error === 'insufficient_credits') {
        const body = data as { balance?: number; needed?: number };
        setCreditError({ balance: Number(body.balance ?? 0), needed: Number(body.needed ?? 0) });
        return;
      }
      if (!r.ok) { setToast(`Voice preview failed: ${r.status}`); return; }
      refreshCredits();
      const jobId = (data as { job?: { id: string } }).job?.id;
      if (!jobId) { setToast('Voice preview returned no job.'); return; }
      // TTS resolves fast — poll up to 90s. `outcome` separates "the engine
      // refused it" from "we stopped watching": only the first is final.
      let outcome: 'done' | 'failed' | 'timeout' = 'timeout';
      const startedAt = Date.now();
      let interval = 2_000;
      while (Date.now() - startedAt < 90_000) {
        await new Promise((res) => setTimeout(res, interval));
        interval = Math.min(interval + 500, 5_000);
        let pr: Response;
        try { pr = await fetch(`/api/media/gen-job/${jobId}`, { credentials: 'include' }); } catch { continue; }
        if (!pr.ok) continue;
        const pd = await pr.json().catch(() => ({} as Record<string, unknown>)) as {
          status?: 'pending' | 'completed' | 'failed';
          asset?: { publicUrl: string };
          error?: string;
        };
        if (pd.status === 'completed' && pd.asset) { setVoicePreviewUrl(pd.asset.publicUrl); outcome = 'done'; break; }
        if (pd.status === 'failed') {
          // The engine's own string is internal; log it, tell the user what it
          // means for them.
          console.warn('[previewVoice] failed:', pd.error);
          outcome = 'failed';
          break;
        }
      }
      if (outcome === 'failed') setToast('The voice engine could not render that. Credits were refunded — try a shorter script.');
      else if (outcome === 'timeout') setToast('Still synthesizing — it is taking longer than usual. Try again in a moment.');
    } catch (e) {
      setToast(`Voice preview failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVoicePreviewBusy(false);
    }
  };

  const generateAvatar = async () => {
    const useVoice = avatarAudioMode === 'voice';
    const missingFace = !avatarImageUrl;
    const missingVoice = useVoice && !(avatarVoiceId && avatarScript.trim());
    const missingAudio = !useVoice && !audioUrl;
    if (missingFace || missingVoice || missingAudio) {
      setAvatarTouched(true);
      if (missingFace) setToast('Add a face photo for the avatar.');
      else if (missingVoice) setToast('Pick a Voice Twin and type what the avatar should say.');
      else setToast('Upload an audio track to drive the avatar.');
      return;
    }
    setAvatarTouched(false);

    const quality = videoQuality === '1080p' ? '720p' : videoQuality;
    setVideoBusy(true);
    setToast('Bringing your avatar to life — this takes a couple of minutes…');
    try {
      const r = await fetch('/api/media/generate-avatar', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          imageUrl: avatarImageUrl,
          aspect: videoAspect,
          quality,
          prompt: prompt.trim() || undefined,
          ...(useVoice
            ? { voiceId: avatarVoiceId, script: avatarScript.trim() }
            : { audioUrl: audioUrl ?? undefined }),
        }),
      });
      const data = await r.json().catch(() => ({} as Record<string, unknown>));
      if (r.status === 402 && (data as { error?: string })?.error === 'insufficient_credits') {
        const body = data as { balance?: number; needed?: number };
        setCreditError({ balance: Number(body.balance ?? 0), needed: Number(body.needed ?? 0) });
        setToast(null);
        refreshCredits();
        return;
      }
      if (!r.ok) {
        if (r.status === 429) setToast('Slow down — too many avatar generations. Try again shortly.');
        else if (r.status === 400) setToast('Avatar needs a face photo plus a voice + script (or an audio track).');
        else setToast(`Avatar generation failed: ${r.status}`);
        return;
      }
      setCreditError(null);
      refreshCredits();

      const jobId = (data as { job?: { id: string } }).job?.id;
      if (!jobId) { setToast('Avatar queue returned no job.'); return; }

      // Poll the single gen-job. Avatar renders take minutes; cap at 8.
      const startedAt = Date.now();
      const maxMs = 8 * 60_000;
      let interval = 5_000;
      let asset: { id: string; publicUrl: string; mimeType: string; label?: string } | null = null;
      // Same distinction the video poller makes: the engine refusing the job is
      // final and refunded, us giving up on the poll is neither.
      let engineFailed = false;
      while (Date.now() - startedAt < maxMs) {
        await new Promise((res) => setTimeout(res, interval));
        interval = Math.min(interval + 1_000, 12_000);
        let pr: Response;
        try { pr = await fetch(`/api/media/gen-job/${jobId}`, { credentials: 'include' }); } catch { continue; }
        if (!pr.ok) continue;
        const pd = await pr.json().catch(() => ({} as Record<string, unknown>)) as {
          status?: 'pending' | 'completed' | 'failed';
          asset?: { id: string; publicUrl: string; mimeType: string; label?: string };
          error?: string;
        };
        if (pd.status === 'completed' && pd.asset) { asset = pd.asset; break; }
        if (pd.status === 'failed') { console.warn('[generateAvatar] failed:', pd.error); engineFailed = true; break; }
      }
      refreshCredits();
      if (asset) {
        setMedia((m) => [...m, {
          kind: 'video',
          label: asset!.label || (useVoice ? avatarScript.slice(0, 60) : 'Avatar'),
          tag: 'Avatar',
          id: asset!.id,
          url: asset!.publicUrl,
          mimeType: asset!.mimeType,
          aspect: videoAspect.replace(':', '/'),
        }]);
        setToast('Avatar video ready.');
        setTimeout(() => {
          generatedMediaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
      } else {
        setToast(engineFailed
          ? 'The avatar engine could not render that. Credits were refunded — a clearer, front-facing photo or a shorter script usually fixes it.'
          : 'Still rendering after 8 minutes — the clip will appear in your library once it lands.');
      }
      setTimeout(() => setToast(null), asset ? 5_000 : 12_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(`Avatar generation failed: ${msg}`);
    } finally {
      setVideoBusy(false);
    }
  };

  const { data: accounts, unauth } = useApi<Account[]>('/api/accounts');
  const connectedShorts = useMemo(
    () => (accounts ?? []).map((a) => PLATFORM_TO_SHORT[a.platform]),
    [accounts],
  );

  // Hydrate the media grid with the user's previously generated images
  // and videos on mount. Without this, refreshing the page or coming
  // back from another tab wipes everything you've made. Drafts override
  // this (a draft's media list is canonical for that draft).
  useEffect(() => {
    if (draftId) return; // draft loader below handles its own media
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/media?limit=40', { credentials: 'include' });
        if (!r.ok) return;
        const data = (await r.json()) as {
          items: Array<{
            id: string;
            publicUrl: string;
            mimeType: string;
            label: string | null;
            width: number | null;
            height: number | null;
          }>;
        };
        if (cancelled) return;
        const restored: MediaItem[] = data.items.map((row) => {
          const isVideo = row.mimeType.startsWith('video/');
          const aspect = row.width && row.height ? `${row.width}/${row.height}` : undefined;
          return {
            kind: isVideo ? 'video' : 'image',
            label: row.label ?? (isVideo ? 'Generated clip' : 'Generated image'),
            tag: 'Library',
            id: row.id,
            url: row.publicUrl,
            mimeType: row.mimeType,
            aspect,
          };
        });
        setMedia((prev) => {
          // De-dupe by id — a freshly generated item may already be in
          // local state if the user generated something during this load.
          const seen = new Set(prev.map((m) => m.id).filter(Boolean));
          return [...prev, ...restored.filter((r) => !r.id || !seen.has(r.id))];
        });
      } catch {
        // Library hydration is best-effort. Silent failure keeps the UI usable.
      }
    })();
    return () => { cancelled = true; };
  }, [draftId]);

  // Load existing draft when editing. Intentionally syncs prop → state so
  // the form repopulates when ?draft=… changes.
  useEffect(() => {
    if (!draftId) {
      setLoadedDraftId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/drafts/${draftId}`, { credentials: 'include' });
        if (!r.ok) {
          if (!cancelled) setToast(`Couldn't load draft (${r.status})`);
          return;
        }
        const d = (await r.json()) as {
          id: string;
          prompt: string | null;
          body: string;
          variants: Array<{ label?: string; text: string; score?: number; rationale?: string }>;
          selectedVariantLabel: string | null;
          targetPlatforms: Platform[];
          perPlatformText: Partial<Record<Platform, string>>;
          preset: string | null;
          source: 'user' | 'agent';
          media: { id: string; url: string; mimeType: string }[];
        };
        if (cancelled) return;
        setLoadedDraftId(d.id);
        setDraftSource(d.source);
        if (d.prompt) setPrompt(d.prompt);
        if (d.preset) setPreset(d.preset);
        if (d.variants && d.variants.length > 0) {
          const incoming = d.variants.map((v, i) => ({
            id: v.label || (['A', 'B', 'C', 'D'][i] ?? `V${i + 1}`),
            name: v.label ? `Variant ${v.label}` : `Variant ${['A', 'B', 'C', 'D'][i] ?? i + 1}`,
            score: typeof v.score === 'number' ? v.score : 80,
            text: v.text,
            rationale: v.rationale,
          }));
          setVariants(incoming);
          setActive(d.selectedVariantLabel ?? incoming[0].id);
        } else if (d.body) {
          setVariants([{ id: 'A', name: 'Variant A', score: 80, text: d.body }]);
          setActive('A');
        }
        setPerPlatform(d.perPlatformText ?? {});
        setPlatforms(d.targetPlatforms.map((p) => PLATFORM_TO_SHORT[p]).filter(Boolean));
        if (d.media && d.media.length > 0) {
          setMedia(d.media.map((m) => ({
            id: m.id, url: m.url, mimeType: m.mimeType,
            kind: m.mimeType.startsWith('video/') ? 'video' : 'image',
            label: m.url.split('/').pop() || 'asset',
            tag: 'Uploaded',
          })));
        }
        setToast(`Loaded ${d.source === 'agent' ? 'agent' : 'your'} draft`);
        setTimeout(() => setToast(null), 2200);
      } catch (e) {
        if (!cancelled) setToast(`Couldn't load draft: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [draftId]);

  // Default platform selection to whatever the user has connected (cap at 3).
  // Syncs from the accounts API response; setState updaters guard against
  // overwriting an explicit user selection.
  useEffect(() => {
    if (accounts && accounts.length > 0) {
      const initial = accounts.slice(0, 3).map((a) => PLATFORM_TO_SHORT[a.platform]);
      setPlatforms((cur) => (cur.length === 0 || cur.every((p) => !connectedShorts.includes(p)) ? initial : cur));
      setPreviewPlat((cur) => (initial.includes(cur) ? cur : initial[0] ?? 'x'));
    }
  }, [accounts, connectedShorts]);

  const variant = variants.find((v) => v.id === active) ?? variants[0];
  const charCount = variant?.text.length ?? 0;
  const limit = PLATFORM_LIST.find((p) => p.id === previewPlat)?.limit ?? 3000;
  // Validate the caption against EVERY selected platform's limit, not just the
  // one currently previewed — X (280) is much stricter than LinkedIn (3000),
  // and a user editing on the LinkedIn tab shouldn't silently blow past X.
  const overLimitPlatforms = useMemo(
    () =>
      platforms
        .map((s) => PLATFORM_BY_SHORT[s])
        .filter((p): p is PlatformMeta => Boolean(p) && charCount > p.limit),
    [platforms, charCount],
  );

  // Build the Author for the currently-previewed platform from the user's
  // connected accounts. Falls back to "You" when not connected.
  const previewAccount = useMemo(() => {
    const fullPlatform = SHORT_TO_PLATFORM[previewPlat];
    return (accounts ?? []).find((a) => a.platform === fullPlatform);
  }, [accounts, previewPlat]);
  const previewAuthor: Author = useMemo(() => ({
    name: previewAccount?.displayName?.trim()
      || previewAccount?.handle?.trim()
      || 'You',
    handle: previewAccount?.handle ?? undefined,
    avatar: previewAccount?.avatarUrl ?? undefined,
    // LinkedIn-style subline. Only used by PostLI today.
    headline: previewPlat === 'li' ? 'Founder' : undefined,
  }), [previewAccount, previewPlat]);

  // Caption + media generation fired together so the user gets a complete
  // post in one click. Each runs independently — a failure in one doesn't
  // sink the other.
  const generateAll = async () => {
    const tasks: Promise<unknown>[] = [generate({ withTools: withResearch })];
    if (mode === 'image') tasks.push(generateImage());
    if (mode === 'video') tasks.push(videoGenMode === 'avatar' ? generateAvatar() : generateVideo());
    await Promise.allSettled(tasks);
  };

  // The image/video "Describe X" section is now embedded INSIDE the main
  // Compose card (one card, one Generate button). These two helpers return
  // just the inner body — textarea + sliders — without their own card wrapper.
  const imageSection = (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon name="image" size={14} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 12, fontWeight: 550, letterSpacing: '-0.005em' }}>Image options</span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>
          Uses the post topic above
        </span>
      </div>
      <div className="m-2col" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14, marginTop: 4 }}>
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>How many</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={imageCount === n}
                className={`prompt-chip ${imageCount === n ? 'active' : ''}`}
                onClick={() => setImageCount(n)}
                style={{ minWidth: 28, justifyContent: 'center', textAlign: 'center' }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Ratio</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {IMAGE_SIZE_OPTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={imageSize === s.id}
                className={`prompt-chip ${imageSize === s.id ? 'active' : ''}`}
                onClick={() => setImageSize(s.id)}
                title={s.id}
              >
                {s.ratio}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Quality</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['low', 'medium', 'high'] as ImageQuality[]).map((q) => (
              <button
                key={q}
                type="button"
                aria-pressed={imageQuality === q}
                className={`prompt-chip ${imageQuality === q ? 'active' : ''}`}
                onClick={() => setImageQuality(q)}
                title={q === 'low' ? 'Fastest' : q === 'high' ? 'Highest fidelity' : 'Balanced'}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Reference images — the output imitates these, so a generated ring can
          be THEIR ring. Picked from the gallery below rather than uploaded
          again; the surcharge is shown before they commit. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          References ({imageRefUrls.length}/{MAX_IMAGE_REFS})
        </div>
        {imageRefUrls.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>
            Hit <strong>Ref</strong> on any image below to copy its subject — +{priceForImage(imageSize, imageQuality, 1).surcharge} credits each.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {imageRefUrls.map((url, i) => (
              <div key={url} style={{ width: 44, height: 44, borderRadius: 6, border: '1px solid var(--line-2)', position: 'relative', overflow: 'hidden', background: 'var(--bg-sunk)' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={`reference ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button
                  type="button"
                  aria-label={`Remove reference ${i + 1}`}
                  onClick={() => toggleImageRef(url)}
                  style={{ position: 'absolute', top: 0, right: 0, width: 16, height: 16, background: 'rgba(10,10,10,0.7)', color: 'white', border: 0, display: 'grid', placeItems: 'center', cursor: 'pointer', padding: 0 }}
                >
                  <Icon name="x" size={9} />
                </button>
              </div>
            ))}
            <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
              +{priceForImage(imageSize, imageQuality, imageRefUrls.length).surcharge} credits{imageCount > 1 ? ` × ${imageCount}` : ''} · likeness is guided, not exact
            </span>
          </div>
        )}
      </div>
    </div>
  );

  const videoSection = (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon name="play" size={14} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 12, fontWeight: 550, letterSpacing: '-0.005em' }}>Video options</span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>
          {videoDuration}s · {videoQuality} · {videoGenMode === 'avatar' ? videoAspect : `${effectiveFast ? 'fast' : 'quality'} · ${videoAspect}`} · uses topic above
        </span>
      </div>
      <div className="m-2col" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14, marginTop: 4 }}>
        {videoGenMode !== 'avatar' && (
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>How many</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={videoCount === n}
                className={`prompt-chip ${videoCount === n ? 'active' : ''}`}
                onClick={() => setVideoCount(n)}
                style={{ minWidth: 28, justifyContent: 'center', textAlign: 'center' }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        )}
        {videoGenMode !== 'avatar' && (
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Duration</div>
          <input
            type="range"
            min={4}
            max={15}
            step={1}
            value={videoDuration}
            onChange={(e) => setVideoDuration(parseInt(e.target.value, 10))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-2)', marginTop: 2 }}>{videoDuration}s</div>
        </div>
        )}
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Quality</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {((videoGenMode === 'avatar' ? ['480p', '720p'] : ['480p', '720p', '1080p']) as VideoQuality[]).map((q) => (
              <button
                key={q}
                type="button"
                aria-pressed={videoQuality === q}
                className={`prompt-chip ${videoQuality === q ? 'active' : ''}`}
                onClick={() => setVideoQuality(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Aspect</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(['9:16', '1:1', '16:9'] as VideoAspect[]).map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={videoAspect === a}
                className={`prompt-chip ${videoAspect === a ? 'active' : ''}`}
                onClick={() => setVideoAspect(a)}
              >
                {a}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Speed/quality tier. Fast = seedance-2-fast, ~20% cheaper at the same
          resolution and the recommended default (COSTS.md). No 1080p variant. */}
      {videoGenMode !== 'avatar' && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Model</div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            {[true, false].map((f) => (
              <button
                key={String(f)}
                type="button"
                aria-pressed={effectiveFast === f}
                className={`prompt-chip ${effectiveFast === f ? 'active' : ''}`}
                disabled={f && videoQuality === '1080p'}
                onClick={() => setVideoFast(f)}
                title={f ? 'seedance-2-fast — cheaper, quicker' : 'seedance-2 — more detail'}
              >
                {f ? 'Fast' : 'Quality'}
              </button>
            ))}
            <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>
              {videoQuality === '1080p' ? 'Fast has no 1080p variant.' : 'Fast costs ~20% fewer credits.'}
            </span>
          </div>
        </div>
      )}

      {/* Generation type — drives which inputs render below. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>How to generate</div>
        <div className="m-2col" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
          {VIDEO_GEN_MODES.map((m) => {
            const isActive = videoGenMode === m.id;
            const isAvatar = m.id === 'avatar';
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => setVideoGenMode(m.id)}
                style={{
                  textAlign: 'left', padding: '10px 12px', borderRadius: 10,
                  border: isActive
                    ? '1px solid var(--ink)'
                    : isAvatar ? '1px solid var(--accent)' : '1px solid var(--line)',
                  background: isActive ? 'var(--ink)' : isAvatar ? 'var(--accent-soft)' : 'var(--bg-elev)',
                  color: isActive ? 'var(--bg)' : isAvatar ? 'var(--accent-ink)' : 'var(--ink)',
                  cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Icon name={m.icon} size={11} />
                  <span style={{ fontSize: 11.5, fontWeight: 600 }}>{m.label}</span>
                  {isAvatar && (
                    <span
                      style={{
                        marginLeft: 'auto', fontSize: 8.5, fontWeight: 700, letterSpacing: '0.06em',
                        textTransform: 'uppercase', padding: '2px 6px', borderRadius: 100,
                        background: isActive ? 'rgba(255,255,255,0.18)' : 'var(--accent)',
                        color: isActive ? 'var(--bg)' : 'white',
                      }}
                    >
                      Talking head
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 10, opacity: 0.7, fontFamily: 'var(--mono)' }}>{m.sub}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Anchors — only render the slots relevant to the picked mode. */}
      {videoGenMode !== 'text' && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Inputs</span>
            <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>
              {videoGenMode === 'image-to-video' && 'Start frame seeds the clip. End frame is optional.'}
              {videoGenMode === 'reference'      && 'Up to 9 images + optionally a reference video.'}
              {videoGenMode === 'audio-driven'   && 'Motion synced to your audio track.'}
              {videoGenMode === 'avatar'         && 'A face photo speaks your script in your own voice.'}
            </span>
          </div>

          {videoGenMode === 'image-to-video' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <FrameSlot
                label="Start frame *"
                url={startFrameUrl}
                onUpload={() => onPickFrame('start')}
                onClear={() => setStartFrameUrl(null)}
              />
              <FrameSlot
                label="End frame (optional)"
                url={endFrameUrl}
                onUpload={() => onPickFrame('end')}
                onClear={() => setEndFrameUrl(null)}
              />
            </div>
          )}

          {videoGenMode === 'reference' && (
            <div className="m-stack" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Reference images ({referenceImageUrls.length}/9)</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                  {referenceImageUrls.map((url, i) => (
                    <div key={url + i} style={{ aspectRatio: '1/1', borderRadius: 6, border: '1px solid var(--line-2)', position: 'relative', overflow: 'hidden', background: 'var(--bg-sunk)' }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={`ref ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <button
                        type="button"
                        aria-label={`Remove reference image ${i + 1}`}
                        onClick={() => setReferenceImageUrls((cur) => cur.filter((_, j) => j !== i))}
                        style={{ position: 'absolute', top: 0, right: 0, minWidth: 32, minHeight: 32, padding: 4, background: 'transparent', border: 0, display: 'grid', placeItems: 'center', cursor: 'pointer' }}
                      >
                        <span style={{ width: 16, height: 16, borderRadius: 3, background: 'rgba(10,10,10,0.7)', color: 'white', display: 'grid', placeItems: 'center' }}>
                          <Icon name="x" size={9} />
                        </span>
                      </button>
                    </div>
                  ))}
                  {referenceImageUrls.length < 9 && (
                    <button
                      onClick={() => onPickFrame('reference')}
                      style={{ aspectRatio: '1/1', borderRadius: 6, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', color: 'var(--ink-3)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}
                      title="Add reference image"
                    >
                      <Icon name="plus" size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Reference video</div>
                {referenceVideoUrl ? (
                  <div style={{ aspectRatio: '16/9', borderRadius: 8, border: '1px solid var(--line-2)', position: 'relative', overflow: 'hidden', background: '#000' }}>
                    <video src={referenceVideoUrl} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <button
                      onClick={() => { setReferenceVideoUrl(null); setRefVideoSec(null); }}
                      style={{ position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 4, background: 'rgba(10,10,10,0.7)', color: 'white', border: 0, display: 'grid', placeItems: 'center', cursor: 'pointer' }}
                    >
                      <Icon name="x" size={10} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onPickFrame('refVideo')}
                    style={{ width: '100%', aspectRatio: '16/9', borderRadius: 8, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', color: 'var(--ink-3)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, cursor: 'pointer', fontSize: 11, fontFamily: 'var(--mono)' }}
                  >
                    <Icon name="upload" size={14} />
                    <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 9.5 }}>Upload</span>
                  </button>
                )}
                {/* The clip's own length is billed on top (Seedance charges half
                    the per-second rate for input), so surface it here. */}
                {referenceVideoUrl && (
                  <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: refVideoSec == null || refVideoSec > 60 ? 'var(--danger, #c0392b)' : 'var(--ink-3)', marginTop: 4 }}>
                    {refVideoSec == null
                      ? 'Length unreadable — re-upload as MP4/MOV'
                      : refVideoSec > 60
                        ? `${Math.round(refVideoSec)}s — max 60s`
                        : `${Math.round(refVideoSec)}s input · billed on top`}
                  </div>
                )}
              </div>
            </div>
          )}

          {videoGenMode === 'audio-driven' && (
            <div>
              <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Audio track *</div>
              {audioUrl ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 10, border: '1px solid var(--line-2)', background: 'var(--bg-sunk)' }}>
                  <Icon name="bolt" size={16} style={{ color: 'var(--accent)' }} />
                  <audio src={audioUrl} controls style={{ flex: 1, height: 32 }} />
                  <button
                    onClick={() => setAudioUrl(null)}
                    className="btn sm ghost"
                    aria-label="Remove audio"
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => onPickFrame('audio')}
                  style={{ width: '100%', padding: 20, borderRadius: 10, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer', fontSize: 12, fontFamily: 'var(--mono)' }}
                >
                  <Icon name="upload" size={18} />
                  <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Upload audio track</span>
                  <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>MP3 / WAV / M4A / OGG · up to 50 MB</span>
                </button>
              )}
            </div>
          )}

          {videoGenMode === 'avatar' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Step 1 — Face */}
              <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 14, alignItems: 'start' }} className="m-stack">
                <div>
                  <FrameSlot
                    label="Face photo *"
                    url={avatarImageUrl}
                    onUpload={() => onPickFrame('avatarFace')}
                    onClear={() => { setAvatarImageUrl(null); setAvatarFaceFile(null); }}
                  />
                  {avatarFaceFile && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      style={{ marginTop: 6, width: '100%' }}
                      onClick={() => setCropOpen(true)}
                      title={`Re-crop to ${videoAspect}`}
                    >
                      <Icon name="grid" size={11} /> Crop to {videoAspect}
                    </button>
                  )}
                  {avatarTouched && !avatarImageUrl && (
                    <div role="status" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--danger)' }}>
                      <Icon name="alert" size={10} /> Add a face photo
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.6, paddingTop: 4 }}>
                  Use a clear, front-facing photo with one face and even lighting. Looking at the camera works best.
                  <div style={{ marginTop: 6, color: 'var(--ink-4)' }}>
                    Tip: the photo is cropped to <span style={{ fontFamily: 'var(--mono)' }}>{videoAspect}</span> to match your video — change the aspect above before cropping.
                  </div>
                </div>
              </div>

              {/* Step 2 — Voice & script */}
              <div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <button
                    type="button"
                    aria-pressed={avatarAudioMode === 'voice'}
                    className={`prompt-chip ${avatarAudioMode === 'voice' ? 'active' : ''}`}
                    onClick={() => setAvatarAudioMode('voice')}
                  >
                    Your Voice Twin
                  </button>
                  <button
                    type="button"
                    aria-pressed={avatarAudioMode === 'audio'}
                    className={`prompt-chip ${avatarAudioMode === 'audio' ? 'active' : ''}`}
                    onClick={() => setAvatarAudioMode('audio')}
                  >
                    Upload audio
                  </button>
                </div>

                {avatarAudioMode === 'voice' ? (
                  myVoices.length === 0 ? (
                    <div style={{ padding: 14, borderRadius: 10, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.6 }}>
                      Create your Voice Twin so the avatar can speak in your voice — or switch to “Upload audio”.
                      <div style={{ marginTop: 8 }}>
                        <VoicePicker value={avatarVoiceId} onChange={setAvatarVoiceId} />
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <VoicePicker value={avatarVoiceId} onChange={setAvatarVoiceId} />
                      <textarea
                        value={avatarScript}
                        onChange={(e) => { setAvatarScript(e.target.value); setVoicePreviewUrl(null); }}
                        placeholder="What should the avatar say?"
                        rows={3}
                        maxLength={2000}
                        style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-sunk)', color: 'var(--ink)', fontSize: 12.5, resize: 'vertical' }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={voicePreviewBusy || !(avatarVoiceId && avatarScript.trim())}
                          onClick={previewVoice}
                          title="Hear this voice say your script before generating the video"
                        >
                          <Icon name="play" size={11} /> {voicePreviewBusy ? 'Synthesizing…' : 'Preview voice'}
                        </button>
                        {voicePreviewUrl && <audio src={voicePreviewUrl} controls style={{ flex: 1, minWidth: 180, height: 30 }} />}
                        <span style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>{avatarScript.length}/2000 · clip length follows your script</span>
                      </div>
                      {avatarTouched && !(avatarVoiceId && avatarScript.trim()) && (
                        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--danger)' }}>
                          <Icon name="alert" size={10} /> Pick a voice and write a script
                        </div>
                      )}
                    </div>
                  )
                ) : (
                  audioUrl ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 10, border: '1px solid var(--line-2)', background: 'var(--bg-sunk)' }}>
                      <Icon name="waveform" size={16} style={{ color: 'var(--accent)' }} />
                      <audio src={audioUrl} controls style={{ flex: 1, height: 32 }} />
                      <button onClick={() => setAudioUrl(null)} className="btn sm ghost" aria-label="Remove audio"><Icon name="x" size={11} /></button>
                    </div>
                  ) : (
                    <button
                      onClick={() => onPickFrame('audio')}
                      style={{ width: '100%', padding: 20, borderRadius: 10, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer', fontSize: 12, fontFamily: 'var(--mono)' }}
                    >
                      <Icon name="upload" size={18} />
                      <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Upload audio track</span>
                      <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>MP3 / WAV / M4A / OGG · up to 50 MB</span>
                    </button>
                  )
                )}
                {avatarTouched && avatarAudioMode === 'audio' && !audioUrl && (
                  <div role="status" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--danger)' }}>
                    <Icon name="alert" size={10} /> Upload an audio track
                  </div>
                )}
              </div>
            </div>
          )}

          <input ref={refUploadRef} type="file" hidden onChange={onFrameChange} />
        </div>
      )}
    </div>
  );

  // Media filtered to whatever the current mode emphasizes — image grid for
  // image mode, video clips for video mode.
  const modeMedia = mode === 'video'
    ? media.filter((m) => m.kind === 'video')
    : mode === 'image'
      ? media.filter((m) => m.kind === 'image')
      : [];
  const currentMediaItem = modeMedia[Math.min(selectedMediaIdx, Math.max(modeMedia.length - 1, 0))];
  const currentMediaUrl = currentMediaItem?.url;

  const generate = async (opts?: { withTools?: boolean }) => {
    setGenerating(true);
    setToast(null);
    try {
      const fullPlatforms = platforms.map((s) => SHORT_TO_PLATFORM[s]).filter(Boolean) as Platform[];
      const r = await apiPost<{ variants: Variant[]; perPlatform: Partial<Record<Platform, string>>; stub?: boolean; toolsUsed?: string[] }>(
        '/api/compose/variants',
        { prompt, preset, platforms: fullPlatforms, withTools: opts?.withTools === true },
      );
      const incoming = (r.variants ?? []).map((v, i) => ({
        id: v.id || (['A', 'B', 'C', 'D'][i] ?? `V${i + 1}`),
        name: v.id ? `Variant ${v.id}` : `Variant ${['A', 'B', 'C', 'D'][i] ?? i + 1}`,
        score: typeof v.score === 'number' ? v.score : 80,
        text: v.text,
        rationale: v.rationale,
      }));
      if (incoming.length > 0) {
        setVariants(incoming);
        setActive(incoming[0].id);
      }
      setPerPlatform(r.perPlatform ?? {});
      setCreditError(null);
      refreshCredits();
      // Note: `r.stub` previously triggered a "demo mode" toast. We removed
      // that — when the user is signed in with a real AI key, stub never
      // fires, and when it does it's because Clerk is still hydrating; the
      // banner below covers that case more clearly.
      if (opts?.withTools && r.toolsUsed?.length) {
        setToast(`Researched with ${r.toolsUsed.join(' + ')} before drafting.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // apiPost throws "${status}: ${body}" — sniff for 402 + structured body.
      const m = msg.match(/^402:\s*(\{.*\})/);
      if (m) {
        try {
          const body = JSON.parse(m[1]) as { balance?: number; needed?: number };
          setCreditError({ balance: Number(body.balance ?? 0), needed: Number(body.needed ?? 0) });
          setToast(null);
          refreshCredits();
          return;
        } catch { /* fall through */ }
      }
      // 503 now carries a structured { error, hint } body for upstream AI
      // failures (quota exhausted, provider down) — show the hint when present.
      const hintMatch = msg.match(/^503:\s*(\{[\s\S]*\})/);
      if (hintMatch) {
        try {
          const body = JSON.parse(hintMatch[1]) as { hint?: string };
          setToast(body.hint ?? 'AI generation is temporarily unavailable. Try again shortly.');
          return;
        } catch { /* fall through */ }
      }
      if (msg.startsWith('401')) {
        setToast('Sign in to generate real variants.');
      } else if (msg.startsWith('503')) {
        setToast('AI generation is temporarily unavailable. Try again shortly.');
      } else if (msg.startsWith('429')) {
        setToast('Slow down — too many compose requests. Try again in a minute.');
      } else {
        setToast(`Generate failed: ${msg}`);
      }
    } finally {
      setGenerating(false);
    }
  };

  const togglePlat = (p: string) => {
    const meta = PLATFORM_BY_SHORT[p];
    if (meta && !meta.supports[mode]) {
      setToast(meta.hint[mode] ?? `${meta.label} doesn't accept this post type.`);
      return;
    }
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  };

  // When mode flips, drop any selected platforms that don't accept the new
  // mode (e.g. switching to Text drops Instagram). Updater short-circuits
  // when the filter is a no-op so it doesn't trigger an extra render.
  useEffect(() => {
    setPlatforms((prev) => {
      const filtered = prev.filter((p) => PLATFORM_BY_SHORT[p]?.supports[mode]);
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [mode]);

  const persistDraft = async () => {
    if (!variant) {
      throw new Error('No variant selected — generate or write a caption first.');
    }
    const fullPlatforms = platforms.map((s) => SHORT_TO_PLATFORM[s]).filter(Boolean) as Platform[];
    const uploadedMedia = media
      .filter((m) => m.url && m.mimeType && m.id && !m.uploading)
      .map((m) => ({ id: m.id!, url: m.url!, mimeType: m.mimeType! }));
    const payload = {
      prompt,
      body: variant.text,
      variants: variants.map((v) => ({ label: v.id, text: v.text, score: v.score, rationale: v.rationale })),
      selectedVariantLabel: variant.id,
      targetPlatforms: fullPlatforms,
      perPlatformText: perPlatform,
      media: uploadedMedia,
      preset,
    };
    if (loadedDraftId) {
      return apiPatch<{ id: string }>(`/api/drafts/${loadedDraftId}`, payload);
    }
    return apiPost<{ id: string }>('/api/drafts', payload);
  };

  const schedule = async (whenIso: string) => {
    setBusy('schedule');
    setToast(null);
    try {
      const draft = await persistDraft();
      const fullPlatforms = platforms.map((s) => SHORT_TO_PLATFORM[s]).filter(Boolean) as Platform[];
      const r = await apiPost<{ scheduled: Array<{ platform: string }> }>('/api/schedule', {
        draftId: draft.id,
        scheduledAt: whenIso,
        platforms: fullPlatforms,
      });
      if (!r.scheduled?.length) {
        setToast('No connected accounts for the selected platforms — connect on Onboarding.');
      } else {
        setToast(`Scheduled to ${r.scheduled.map((s) => s.platform).join(', ')}.`);
        setTimeout(() => onDone?.(), 800);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('401') || msg.startsWith('503')) setToast('Sign in to schedule.');
      else setToast(`Schedule failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const postNow = async () => {
    setBusy('post');
    setToast(null);
    try {
      const draft = await persistDraft();
      const fullPlatforms = platforms.map((s) => SHORT_TO_PLATFORM[s]).filter(Boolean) as Platform[];
      const r = await apiPost<{ results?: Array<{ platform: string; ok: boolean; url?: string | null; error?: string }> }>(
        '/api/publish',
        { draftId: draft.id, platforms: fullPlatforms },
      );
      const results = Array.isArray(r?.results) ? r.results : [];
      if (results.length === 0) {
        setToast('Publish returned no results. Check that the platform is connected and try again.');
        return;
      }
      const ok = results.filter((res) => res.ok);
      const failed = results.filter((res) => !res.ok);
      // Always surface the result via the modal — even full failure — so the
      // user sees real per-platform info + URLs without hunting in a toast,
      // and we DON'T auto-navigate away. They dismiss when ready.
      if (ok.length > 0 || failed.length > 0) {
        setPublishedModal({ ok, failed });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('401') || msg.startsWith('503')) setToast('Sign in to publish.');
      else setToast(`Publish failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const scheduleIn30 = async () => {
    const t = new Date(Date.now() + 30 * 60 * 1000);
    await schedule(t.toISOString());
  };

  return (
    <div className="composer">
      {cropOpen && avatarFaceFile && (
        <AvatarCropModal
          file={avatarFaceFile}
          aspect={videoAspect}
          onApply={applyAvatarFace}
          onUseOriginal={async () => { await applyAvatarFace(avatarFaceFile); }}
          onCancel={() => setCropOpen(false)}
        />
      )}
      <div className="composer-left">
        {creditError && (
          <InsufficientCreditsBanner
            balance={creditError.balance}
            needed={creditError.needed}
            onDismiss={() => setCreditError(null)}
          />
        )}
        {loadedDraftId && (
          <div style={{
            padding: '10px 14px',
            background: 'var(--accent-soft)',
            border: '1px solid oklch(0.86 0.08 70)',
            borderRadius: 10,
            marginBottom: 12,
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 12.5,
            color: 'var(--accent-ink)',
          }}>
            <Icon name="edit" size={13} />
            <span>
              Editing {draftSource === 'agent' ? 'an agent draft' : 'your draft'} · changes save when you schedule or publish.
            </span>
            <div style={{ flex: 1 }} />
            <button className="btn sm ghost" onClick={onDone}>
              <Icon name="x" size={11} /> Close
            </button>
          </div>
        )}

        {/* Mode selector — drives which media panel shows below the prompt. */}
        <div
          className="compose-modes"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 8,
            marginBottom: 12,
          }}
        >
          {MODE_CARDS.map((m) => {
            const isActive = mode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                style={{
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: 12,
                  border: isActive ? '1px solid var(--ink)' : '1px solid var(--line)',
                  background: isActive ? 'var(--ink)' : 'var(--bg-elev)',
                  color: isActive ? 'var(--bg)' : 'var(--ink)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  cursor: 'pointer',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: isActive ? 'rgba(255,255,255,0.12)' : 'var(--bg-sunk)',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Icon name={m.icon} size={14} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</span>
                  <span style={{ fontSize: 11, opacity: 0.75, fontFamily: 'var(--mono)' }}>{m.sub}</span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="prompt-box">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Icon name="sparkle" size={14} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 12, fontWeight: 550, letterSpacing: '-0.005em' }}>{loadedDraftId ? 'Edit prompt' : 'Tell me what to write'}</span>
            <span className="chip ghost mono" style={{ marginLeft: 'auto' }}>Style: from your settings</span>
          </div>
          {!loadedDraftId && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {PROMPT_TEMPLATES.filter((t) => t.modes.includes(mode)).map((t) => (
                <button
                  key={t.label}
                  className="btn sm ghost"
                  style={{ fontSize: 11.5, padding: '4px 10px' }}
                  onClick={() => { setPrompt(t.prompt); setPreset(t.preset); }}
                  title={`Sets preset: ${t.preset}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              mode === 'video'
                ? "What's this post about? The same idea drives the video and the caption."
                : mode === 'image'
                  ? "What's this post about? The same idea drives the image and the caption."
                  : "What's this post about? — e.g. \"Solo founders should treat their newsletter as their #1 channel.\""
            }
          />

          {/* Mode-specific second section — image or video prompt + controls.
              All in the same card so the user has ONE Generate button below. */}
          {mode === 'image' && imageSection}
          {mode === 'video' && videoSection}

          <div className="prompt-foot">
            <div className="prompt-chips">
              {COMPOSE_PRESETS.filter((p) => p.modes.includes(mode)).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={preset === p.id}
                  className={`prompt-chip ${preset === p.id ? 'active' : ''}`}
                  onClick={() => setPreset(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="prompt-spacer" />
            {mode !== 'text' && (
              <label
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                  fontSize: 11, fontFamily: 'var(--mono)', color: autoEnhance ? 'var(--accent-ink)' : 'var(--ink-3)',
                  padding: '4px 10px', borderRadius: 6,
                  background: autoEnhance ? 'var(--accent-soft)' : 'transparent',
                  border: '1px solid ' + (autoEnhance ? 'oklch(0.86 0.08 70)' : 'var(--line)'),
                  marginRight: 6,
                }}
                title="Rewrites your media description through a prompt-rewriter tuned for the target model before generating."
              >
                <input type="checkbox" checked={autoEnhance} onChange={(e) => setAutoEnhance(e.target.checked)} style={{ margin: 0 }} />
                <Icon name="sparkle" size={11} /> Auto-enhance
              </label>
            )}
            <label
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                fontSize: 11, fontFamily: 'var(--mono)', color: withResearch ? 'var(--accent-ink)' : 'var(--ink-3)',
                padding: '4px 10px', borderRadius: 6,
                background: withResearch ? 'var(--accent-soft)' : 'transparent',
                border: '1px solid ' + (withResearch ? 'oklch(0.86 0.08 70)' : 'var(--line)'),
                marginRight: 8,
              }}
              title="Agent searches the web + reads your past posts before drafting. Slower, costs more, much better for time-sensitive topics."
            >
              <input type="checkbox" checked={withResearch} onChange={(e) => setWithResearch(e.target.checked)} style={{ margin: 0 }} />
              <Icon name="globe" size={11} /> With research
            </label>
            <button
              className="btn accent"
              onClick={generateAll}
              disabled={generating || imageBusy || videoBusy || !prompt.trim() || (previewCost ? balance < previewCost.credits : false)}
              title={previewCost && balance < previewCost.credits
                ? `Need ${previewCost.credits} credits · ${balance} remaining`
                : previewCost
                  ? `Costs ${previewCost.credits} credits`
                  : undefined}
            >
              {(generating || imageBusy || videoBusy)
                ? <><Icon name="refresh" size={12} /> {withResearch ? 'Researching' : 'Generating'}</>
                : <><Icon name="sparkle" size={12} />
                    {mode === 'text' && 'Generate 4 variants'}
                    {mode === 'image' && `Generate post${imageCount > 1 ? ` + ${imageCount} images` : ' + image'}`}
                    {mode === 'video' && `Generate post${videoCount > 1 ? ` + ${videoCount} clips` : ' + clip'}`}
                    {previewCost && (
                      <span
                        className={`cost-pill ${balance < previewCost.credits ? 'cant-afford' : ''}`}
                        style={{ background: 'rgba(255,255,255,0.28)', color: 'white' }}
                      >
                        <Icon name="bolt" size={9} /> {previewCost.credits.toLocaleString()}
                      </span>
                    )}
                  </>}
            </button>
          </div>
          {previewCost && (
            <div className="cost-line">
              <Icon name="bolt" size={11} />
              <span>
                <span className="strong">{previewCost.credits.toLocaleString()} credits</span>
                {' · '}{previewCost.label}
                {credits && (
                  <> · balance <span className="strong">{balance.toLocaleString()}</span></>
                )}
                {credits && balance < previewCost.credits && (
                  <> · <span className="danger">need {(previewCost.credits - balance).toLocaleString()} more</span> — <Link href="/billing" style={{ color: 'var(--accent-ink)', textDecoration: 'underline' }}>upgrade</Link></>
                )}
              </span>
            </div>
          )}
        </div>

        {toast && (
          <div role="status" aria-live="polite" style={{ padding: 12, fontSize: 12.5, background: 'rgba(124,77,255,0.06)', border: '1px solid rgba(124,77,255,0.2)', borderRadius: 10, marginBottom: 12 }}>
            {toast}
          </div>
        )}
        {unauth && (
          <div style={{ padding: 12, fontSize: 12.5, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 12 }}>
            <strong>Demo mode.</strong> <Link href="/sign-in?next=/dashboard" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>Sign in</Link> to generate, draft, and schedule for real.
          </div>
        )}

        {/* Variants sit ABOVE Distribution — you pick the winning caption,
            THEN decide where + when to ship it. Compact layout: header chip
            shows which one is selected, 2x2 grid with clamped previews. */}
        {mode !== 'video' && (
          <div className="card">
            <div className="card-head">
              <h3>
                <Icon name="fork" size={14} />
                Variants
                <span className="chip ghost mono">{variants.find((v) => v.id === active)?.id ?? '—'} of {variants.length}</span>
              </h3>
              <button className="btn sm ghost" onClick={() => generate()} disabled={generating}>
                <Icon name="refresh" size={11} /> Regenerate
              </button>
            </div>
            <div className="card-body" style={{ paddingTop: 4 }}>
              {variants.length === 0 ? (
                <div style={{ padding: '20px 12px', textAlign: 'center', fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.6 }}>
                  <Icon name="sparkle" size={16} style={{ color: 'var(--accent)' }} />
                  <div style={{ marginTop: 6 }}>Add a topic above and hit Generate to see caption variants here.</div>
                </div>
              ) : (
              <div className="compose-variant-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                {variants.map((v) => {
                  const isActive = active === v.id;
                  return (
                    <div
                      key={v.id}
                      onClick={() => setActive(v.id)}
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        border: isActive ? '1.5px solid var(--accent)' : '1px solid var(--line)',
                        background: isActive ? 'var(--accent-soft)' : 'var(--bg-sunk)',
                        cursor: 'pointer',
                        transition: 'background 120ms ease, border-color 120ms ease',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: isActive ? 'var(--accent-ink)' : 'var(--ink)' }}>{v.name}</span>
                        {isActive && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9.5, fontFamily: 'var(--mono)', color: 'var(--accent-ink)', textTransform: 'uppercase', letterSpacing: '0.04em' }} title="This caption is editable">
                            <Icon name="edit" size={9} /> Edit
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)' }}>
                          <Icon name={v.score >= 85 ? 'fire' : 'chart'} size={10} style={{ verticalAlign: -1 }} /> {v.score}
                        </span>
                      </div>
                      {isActive ? (
                        <textarea
                          value={v.text}
                          onChange={(e) => {
                            const next = e.target.value;
                            setVariants((cur) => cur.map((x) => x.id === v.id ? { ...x, text: next } : x));
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: '100%', minHeight: 64, padding: 8, fontSize: 12.5,
                            background: 'var(--bg)', border: '1px solid var(--line-2)', borderRadius: 6,
                            outline: 'none', color: 'var(--ink)', fontFamily: 'inherit', resize: 'vertical',
                            lineHeight: 1.5,
                          }}
                        />
                      ) : (
                        <div style={{
                          fontSize: 12, lineHeight: 1.5, color: 'var(--ink-2)',
                          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                          overflow: 'hidden', whiteSpace: 'pre-wrap',
                        }}>
                          {v.text}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-head">
            <h3><Icon name="globe" size={14} /> Distribution</h3>
            <span className="meta">{platforms.length} platforms · adapts per channel</span>
          </div>
          <div className="card-body distribution-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {PLATFORM_LIST.map((p) => {
              const isConnected = connectedShorts.includes(p.id);
              const isSelected = platforms.includes(p.id);
              const supportsMode = p.supports[mode];
              // Selected chips always read as "on". Unsupported-for-this-mode
              // gets the strongest dim; unconnected gets a softer dim.
              const opacity = isSelected ? 1 : supportsMode ? (isConnected ? 1 : 0.6) : 0.35;
              const title = !supportsMode
                ? (p.hint[mode] ?? `${p.label} doesn't accept ${mode} posts.`)
                : isConnected
                  ? 'Connected'
                  : 'Not connected — connect in Onboarding to actually post';
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={isSelected}
                  className={`prompt-chip ${isSelected ? 'active' : ''}`}
                  onClick={() => togglePlat(p.id)}
                  style={{
                    opacity,
                    cursor: supportsMode ? 'pointer' : 'not-allowed',
                    textDecoration: !supportsMode ? 'line-through' : undefined,
                  }}
                  title={title}
                >
                  <Pglyph p={p.id} /> {platformLabel(p, mode)}
                  {!isConnected && supportsMode && (
                    <span
                      style={{ fontSize: 9.5, fontFamily: 'var(--mono)', opacity: 0.7, marginLeft: 4 }}
                      aria-label="not connected"
                    >
                      ·
                    </span>
                  )}
                </button>
              );
            })}
            <div className="dist-spacer" style={{ flex: 1 }} />
            <input
              type="datetime-local"
              value={customSchedule}
              min={minDateTimeLocal()}
              onChange={(e) => setCustomSchedule(e.target.value)}
              style={{
                padding: '6px 8px',
                border: '1px solid var(--line-2)',
                borderRadius: 6,
                fontFamily: 'var(--mono)',
                fontSize: 11.5,
                background: 'var(--bg-elev)',
                color: 'var(--ink)',
              }}
              title="Pick a date and time to schedule"
            />
            <button
              className="btn sm"
              disabled={busy !== null || !variant}
              title={!variant ? 'Generate a caption first' : undefined}
              onClick={() => customSchedule ? schedule(new Date(customSchedule).toISOString()) : scheduleIn30()}
            >
              <Icon name="clock" size={12} /> {busy === 'schedule' ? 'Scheduling…' : customSchedule ? 'Schedule' : 'Schedule (+30m)'}
            </button>
            <button
              className="btn sm primary"
              disabled={busy !== null || !variant}
              title={!variant ? 'Generate a caption first' : undefined}
              onClick={postNow}
            >
              <Icon name="send" size={12} /> {busy === 'post' ? 'Posting…' : 'Post now'}
            </button>
          </div>
        </div>

        {/* === IMAGE MODE — output gallery (the input card sits above Distribution) === */}
        {mode === 'image' && (
          <>
            <div className="card" ref={generatedMediaRef}>
              <div className="card-head">
                <h3><Icon name="image" size={14} /> Your images <span className="chip ghost mono">{modeMedia.length}</span></h3>
                <div className="media-tabs">
                  {(['image', 'carousel'] as MediaKind[]).map((k) => (
                    <button key={k} type="button" aria-pressed={mediaKind === k} className={`opt ${mediaKind === k ? 'active' : ''}`} onClick={() => setMediaKind(k)}>
                      <Icon name={k === 'image' ? 'image' : 'grid'} size={11} />
                      {k.charAt(0).toUpperCase() + k.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="card-body">
                <div className="compose-media-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                  {modeMedia.map((m, i) => {
                    const isHero = i === Math.min(selectedMediaIdx, Math.max(modeMedia.length - 1, 0));
                    return (
                      <div
                        key={m.id ?? i}
                        onClick={() => setSelectedMediaIdx(i)}
                        style={{
                          aspectRatio: '1/1', position: 'relative', overflow: 'hidden', borderRadius: 10,
                          border: isHero ? '2px solid var(--accent)' : '1px solid var(--line-2)',
                          background: 'var(--bg-sunk)', cursor: 'pointer',
                          boxShadow: isHero ? '0 0 0 3px var(--accent-soft)' : 'none',
                        }}
                      >
                        {m.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.url} alt={m.label} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                        ) : (
                          <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: 'var(--ink-3)' }}>
                            <Icon name="image" size={22} />
                          </div>
                        )}
                        <span style={{ position: 'absolute', top: 6, left: 6, fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 5px', background: 'rgba(10,10,10,0.7)', color: 'white', borderRadius: 3, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{m.tag}</span>
                        {isHero && (
                          <span style={{ position: 'absolute', bottom: 6, left: 6, fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 5px', background: 'var(--accent)', color: 'white', borderRadius: 3, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Hero</span>
                        )}
                        {/* Reference toggle — reuses what the user already has
                            in the library instead of a second upload flow. */}
                        {m.url && (() => {
                          const refIdx = imageRefUrls.indexOf(m.url);
                          return (
                            <button
                              type="button"
                              aria-pressed={refIdx >= 0}
                              onClick={(e) => { e.stopPropagation(); toggleImageRef(m.url!); }}
                              title={refIdx >= 0 ? 'Remove from references' : `Copy this subject in the next generation (+${priceForImage(imageSize, imageQuality, 1).surcharge} credits)`}
                              style={{ position: 'absolute', bottom: 6, right: 6, fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 5px', border: 0, borderRadius: 3, cursor: 'pointer', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'white', background: refIdx >= 0 ? 'var(--accent)' : 'rgba(10,10,10,0.6)' }}
                            >
                              Ref{refIdx >= 0 ? ` ${refIdx + 1}` : ''}
                            </button>
                          );
                        })()}
                        {m.url && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setLightbox({ url: m.url!, label: m.label, kind: m.mimeType?.startsWith('video/') ? 'video' : 'image' }); }}
                            style={{ position: 'absolute', top: 0, right: 30, minWidth: 32, minHeight: 32, padding: 4, background: 'transparent', display: 'grid', placeItems: 'center', border: 0, cursor: 'pointer' }}
                            aria-label="Expand image"
                            title="View full size"
                          >
                            <span style={{ width: 22, height: 22, borderRadius: 4, background: 'rgba(10,10,10,0.6)', color: 'white', display: 'grid', placeItems: 'center' }}>
                              <Icon name="maximize" size={11} />
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setMedia(media.filter((it) => it !== m)); }}
                          style={{ position: 'absolute', top: 0, right: 0, minWidth: 32, minHeight: 32, padding: 4, background: 'transparent', display: 'grid', placeItems: 'center', border: 0, cursor: 'pointer' }}
                          aria-label="Remove image"
                        >
                          <span style={{ width: 22, height: 22, borderRadius: 4, background: 'rgba(10,10,10,0.6)', color: 'white', display: 'grid', placeItems: 'center' }}>
                            <Icon name="x" size={11} />
                          </span>
                        </button>
                      </div>
                    );
                  })}
                  <button style={{ aspectRatio: '1/1', borderRadius: 10, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--ink-3)', fontSize: 11, fontFamily: 'var(--mono)' }} onClick={onPickFile}>
                    <Icon name="plus" size={16} />
                    <span>Upload</span>
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime" hidden onChange={onFileChange} />
                  <button style={{ aspectRatio: '1/1', borderRadius: 10, border: '1px dashed oklch(0.86 0.08 70)', background: 'var(--accent-soft)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--accent-ink)', fontSize: 11, fontFamily: 'var(--mono)' }} onClick={() => { setStockOpen(true); if (prompt && !stockQuery) { setStockQuery(prompt.slice(0, 60)); runStockSearch(prompt.slice(0, 60)); } }}>
                    <Icon name="search" size={16} />
                    <span>Stock</span>
                  </button>
                </div>

                {/* Stock image picker — collapsible */}
                {stockOpen && (
                  <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg-sunk)' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
                      <Icon name="search" size={12} />
                      <input
                        type="text"
                        value={stockQuery}
                        placeholder="Search Unsplash / Pexels…"
                        onChange={(e) => setStockQuery(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') runStockSearch(stockQuery); }}
                        style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg)', fontSize: 12.5, color: 'var(--ink)' }}
                      />
                      <button className="btn sm" onClick={() => runStockSearch(stockQuery)} disabled={stockLoading || !stockQuery.trim()}>
                        {stockLoading ? 'Searching…' : 'Search'}
                      </button>
                      <button className="btn sm ghost" onClick={() => { setStockOpen(false); setStockResults([]); }}>
                        <Icon name="x" size={11} />
                      </button>
                    </div>
                    {stockResults.length > 0 ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                        {stockResults.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => pickStockImage(r)}
                            title={`${r.description ?? ''}\n${r.attribution ?? ''}`}
                            style={{ aspectRatio: '1/1', borderRadius: 8, border: '1px solid var(--line-2)', overflow: 'hidden', padding: 0, background: 'var(--bg)' }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={r.thumb} alt={r.description ?? ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          </button>
                        ))}
                      </div>
                    ) : !stockLoading && (
                      <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: '8px 4px' }}>
                        {stockQuery ? 'No results. Try a different query.' : 'Search for an image — Unsplash + Pexels under the hood.'}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6, marginTop: 12, fontSize: 11.5, color: 'var(--ink-3)', alignItems: 'center' }}>
                  <Icon name="bolt" size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <span>Click an image to set it as the hero shown in the preview. Agent auto-crops per platform — 1:1 for IG, 16:9 for X/LinkedIn.</span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* === VIDEO MODE — output gallery (the input card sits above Distribution) === */}
        {/* Video output panel — only renders when clips exist. The preview's
            built-in overlay is the sole empty-state entry, so there is exactly
            one place to upload or generate. */}
        {mode === 'video' && modeMedia.length > 0 && (
          <div className="card" ref={generatedMediaRef}>
            <div className="card-head">
              <h3><Icon name="play" size={14} /> Your video <span className="chip ghost mono">{modeMedia.length}</span></h3>
            </div>
            <div className="card-body">
              {/* Match the actual aspect of the selected clip so a 9:16 vertical
                  doesn't get letterboxed inside a 16:9 frame. Falls back to 16/9
                  for legacy media without aspect metadata. */}
              <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line-2)', background: '#000', maxHeight: 560, aspectRatio: currentMediaItem?.aspect ?? '16/9', maxWidth: currentMediaItem?.aspect === '9/16' ? 320 : undefined, margin: '0 auto' }}>
                {currentMediaUrl ? (
                  <video src={currentMediaUrl} controls playsInline style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                ) : (
                  <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff8' }}>Preview unavailable</div>
                )}
              </div>
              {/* Clip-strip: pick which clip is the hero. */}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto', paddingBottom: 4 }}>
                {modeMedia.map((m, i) => {
                  const isHero = i === Math.min(selectedMediaIdx, modeMedia.length - 1);
                  return (
                    <div
                      key={m.id ?? i}
                      onClick={() => setSelectedMediaIdx(i)}
                      style={{
                        flexShrink: 0, width: 96, aspectRatio: '16/9', borderRadius: 8,
                        border: isHero ? '2px solid var(--accent)' : '1px solid var(--line-2)',
                        background: '#181818', position: 'relative', cursor: 'pointer', overflow: 'hidden',
                      }}
                    >
                      {m.url ? (
                        <video src={m.url} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'white' }}><Icon name="play" size={14} /></div>
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setMedia(media.filter((it) => it !== m)); }}
                        style={{ position: 'absolute', top: 0, right: 0, minWidth: 32, minHeight: 32, padding: 4, background: 'transparent', display: 'grid', placeItems: 'center', border: 0, cursor: 'pointer' }}
                        aria-label="Remove clip"
                      >
                        <span style={{ width: 18, height: 18, borderRadius: 4, background: 'rgba(10,10,10,0.7)', color: 'white', display: 'grid', placeItems: 'center' }}>
                          <Icon name="x" size={10} />
                        </span>
                      </button>
                    </div>
                  );
                })}
                <button
                  onClick={onPickFile}
                  style={{ flexShrink: 0, width: 96, aspectRatio: '16/9', borderRadius: 8, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', color: 'var(--ink-3)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}
                  title="Add another clip"
                >
                  <Icon name="plus" size={16} />
                </button>
                <input ref={fileInputRef} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={onFileChange} />
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 12, fontSize: 11.5, color: 'var(--ink-3)', alignItems: 'center' }}>
                <Icon name="bolt" size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <span>Agent auto-crops per platform — 9:16 for TikTok/Reels/Shorts, 16:9 for X/YouTube.</span>
              </div>
            </div>
          </div>
        )}

      </div>

      <div className="composer-right">
        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="eye" size={14} /> Live preview
              {platforms.includes(previewPlat) && PLATFORM_BY_SHORT[previewPlat] && (
                <span className="chip ghost mono" style={{ marginLeft: 8 }}>
                  {platformLabel(PLATFORM_BY_SHORT[previewPlat], mode)}
                </span>
              )}
            </h3>
            <span className="meta mono" style={overLimitPlatforms.length ? { color: 'var(--danger)' } : undefined}>
              {charCount} / {limit}
            </span>
          </div>
          <div className="card-body">
            {overLimitPlatforms.length > 0 && (
              <div
                role="status"
                style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 12, padding: '8px 10px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.5, color: 'var(--danger)', background: 'color-mix(in oklch, var(--danger) 8%, transparent)', border: '1px solid color-mix(in oklch, var(--danger) 30%, transparent)' }}
              >
                <Icon name="alert" size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  Caption is too long for {overLimitPlatforms.map((p) => `${p.label} (${charCount}/${p.limit})`).join(', ')}. Trim it or deselect {overLimitPlatforms.length === 1 ? 'that platform' : 'those platforms'}.
                </span>
              </div>
            )}
            <div className="preview-tabs" style={{ marginBottom: 16 }}>
              {platforms.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={previewPlat === p}
                  className={`preview-tab ${previewPlat === p ? 'active' : ''}`}
                  onClick={() => setPreviewPlat(p)}
                  title={PLATFORM_BY_SHORT[p] ? platformLabel(PLATFORM_BY_SHORT[p], mode) : p}
                >
                  <Pglyph p={p} />
                </button>
              ))}
            </div>
            <PhonePreview
              platform={previewPlat}
              text={variant?.text ?? ''}
              mediaKind={mode === 'text' ? '' : mediaKind}
              mediaCount={media.length}
              mediaUrl={mode === 'text' ? undefined : currentMediaUrl}
              mediaAspect={mode === 'text' ? undefined : currentMediaItem?.aspect}
              onUpload={mode !== 'text' && !currentMediaUrl ? onPickFile : undefined}
              onGenerate={mode === 'image' && !currentMediaUrl
                ? generateImage
                : mode === 'video' && !currentMediaUrl
                  ? generateVideo
                  : undefined}
              onExpand={currentMediaUrl ? () => setLightbox({
                url: currentMediaUrl!,
                label: currentMediaItem?.label,
                kind: currentMediaItem?.mimeType?.startsWith('video/') ? 'video' : 'image',
              }) : undefined}
              author={previewAuthor}
            />
          </div>
        </div>
      </div>

      {/* Published-success modal — shows per-platform status + clickable URLs.
          Stays open until the user dismisses it; we no longer auto-navigate
          back to the dashboard the moment a post lands. */}
      {publishedModal && (
        <div className="modal-scrim" onClick={() => setPublishedModal(null)}>
          <div
            className="modal-sheet"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(520px, 92vw)' }}
          >
            {(() => {
              const allOk = publishedModal.failed.length === 0 && publishedModal.ok.length > 0;
              const partial = publishedModal.ok.length > 0 && publishedModal.failed.length > 0;
              const title = allOk ? 'Published!' : partial ? 'Partial publish' : 'Publish failed';
              const subtitle = allOk
                ? 'Your post is live. Click through to open it on each platform.'
                : partial
                  ? 'Some platforms shipped, others didn\'t. Details below.'
                  : 'No platforms accepted this post.';
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 10,
                      background: allOk ? 'var(--good, oklch(0.68 0.18 155))' : partial ? 'oklch(0.78 0.16 70)' : 'oklch(0.62 0.20 25)',
                      color: 'white', display: 'grid', placeItems: 'center', flexShrink: 0,
                    }}>
                      <Icon name={allOk ? 'check' : partial ? 'bolt' : 'x'} size={14} />
                    </div>
                    <h3 style={{ margin: 0, fontSize: 16, letterSpacing: '-0.01em' }}>{title}</h3>
                    <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setPublishedModal(null)}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 16 }}>
                    {subtitle}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
                    {publishedModal.ok.map((res) => (
                      <div
                        key={`ok-${res.platform}`}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: 12, borderRadius: 10,
                          border: '1px solid var(--line)',
                          background: 'var(--bg-sunk)',
                        }}
                      >
                        <Pglyph p={PLATFORM_TO_SHORT[res.platform as Platform] ?? res.platform} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>
                            {(PLATFORM_BY_SHORT[PLATFORM_TO_SHORT[res.platform as Platform]] &&
                              platformLabel(PLATFORM_BY_SHORT[PLATFORM_TO_SHORT[res.platform as Platform]], mode))
                              || res.platform}
                          </div>
                          {res.url && (
                            <div style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {res.url}
                            </div>
                          )}
                        </div>
                        {res.url && (
                          <a
                            href={res.url}
                            target="_blank"
                            rel="noreferrer"
                            className="btn sm primary"
                            style={{ textDecoration: 'none' }}
                          >
                            <Icon name="arrow_right" size={11} /> View
                          </a>
                        )}
                      </div>
                    ))}
                    {publishedModal.failed.map((res) => {
                      // Heuristic recovery hints based on the platform + error
                      // payload, so users see *what to do* not just *what failed*.
                      const err = res.error ?? '';
                      const isMetaNoPage = /facebook_no_page_selected|no Facebook Page|Select the business assets/i.test(err);
                      const isMetaPermission = /\(#200\)|pages_manage_posts|pages_read_engagement|facebook_missing_permissions|permission|admin/i.test(err);
                      const isAuthExpired = /\b(401|expired|invalid_token|invalid_grant|token)\b/i.test(err) && !isMetaPermission;
                      const isRateLimit = /\b429\b|rate.?limit|too many/i.test(err);
                      const isYtTextUnsupported = /youtube_text_unsupported|requires a video upload/i.test(err);
                      const recoveryHint = isMetaNoPage
                        ? 'You didn\'t pick a Page on the "Select business assets" screen. Reconnect Facebook and choose your Page from the Page dropdown.'
                        : isMetaPermission
                        ? 'Reconnect Facebook from Onboarding and approve every page-publishing permission.'
                        : isAuthExpired
                          ? 'Reconnect this platform — the access token expired or was revoked.'
                          : isRateLimit
                            ? 'You\'re posting too fast for this platform. Wait a minute and try again.'
                            : isYtTextUnsupported
                              ? 'Switch to Video mode — YouTube only accepts video uploads via API.'
                              : null;
                      return (
                        <div
                          key={`fail-${res.platform}`}
                          style={{
                            display: 'flex', alignItems: 'flex-start', gap: 10,
                            padding: 12, borderRadius: 10,
                            border: '1px solid oklch(0.86 0.10 25)',
                            background: 'oklch(0.97 0.03 25)',
                          }}
                        >
                          <Pglyph p={PLATFORM_TO_SHORT[res.platform as Platform] ?? res.platform} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'oklch(0.42 0.20 25)' }}>
                              {(PLATFORM_BY_SHORT[PLATFORM_TO_SHORT[res.platform as Platform]] &&
                                platformLabel(PLATFORM_BY_SHORT[PLATFORM_TO_SHORT[res.platform as Platform]], mode))
                                || res.platform}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'oklch(0.42 0.20 25)', marginTop: 2, lineHeight: 1.4 }}>
                              {err || 'Unknown error'}
                            </div>
                            {recoveryHint && (
                              <div style={{
                                marginTop: 8, padding: '6px 8px', borderRadius: 6,
                                background: 'rgba(255,255,255,0.6)',
                                fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.4,
                                display: 'flex', alignItems: 'center', gap: 6,
                              }}>
                                <Icon name="bolt" size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                                <span>{recoveryHint}</span>
                                {(isMetaPermission || isMetaNoPage || isAuthExpired) && (
                                  <a
                                    href="/onboarding"
                                    style={{ marginLeft: 'auto', color: 'var(--accent)', fontWeight: 600, textDecoration: 'underline' }}
                                  >
                                    Reconnect →
                                  </a>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button className="btn" onClick={() => setPublishedModal(null)}>
                      Keep composing
                    </button>
                    <button
                      className="btn primary"
                      onClick={() => { setPublishedModal(null); onDone?.(); }}
                    >
                      <Icon name="chart" size={11} /> Back to dashboard
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Lightbox — click any generated image's expand icon to view it full-size.
          Closes on backdrop click, ESC, or the close button. */}
      {lightbox && (
        <div
          className="modal-scrim"
          onClick={() => setLightbox(null)}
          style={{ background: 'rgba(0, 0, 0, 0.82)', cursor: 'zoom-out' }}
        >
          <div
            className="modal-sheet"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(92vw, 1400px)',
              maxHeight: '92vh',
              background: 'transparent',
              boxShadow: 'none',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
            }}
          >
            {lightbox.kind === 'video' ? (
              <video
                src={lightbox.url}
                controls
                autoPlay
                playsInline
                style={{
                  maxWidth: '100%',
                  maxHeight: '82vh',
                  borderRadius: 10,
                  boxShadow: '0 24px 64px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)',
                  background: '#000',
                }}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={lightbox.url}
                alt={lightbox.label ?? 'preview'}
                style={{
                  maxWidth: '100%',
                  maxHeight: '82vh',
                  objectFit: 'contain',
                  borderRadius: 10,
                  boxShadow: '0 24px 64px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)',
                  background: '#000',
                }}
              />
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <a
                href={lightbox.url}
                target="_blank"
                rel="noopener noreferrer"
                className="chip ghost"
                style={{ color: 'white', borderColor: 'rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.06)' }}
              >
                <Icon name="arrow_up_right" size={11} /> Open original
              </a>
              <button
                onClick={() => setLightbox(null)}
                className="chip ghost"
                style={{ color: 'white', borderColor: 'rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.06)' }}
                aria-label="Close preview"
              >
                <Icon name="x" size={11} /> Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function minDateTimeLocal(): string {
  const d = new Date(Date.now() + 60 * 1000); // can't pick the past
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default Compose;
