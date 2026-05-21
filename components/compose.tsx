'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Pglyph } from './icons';
import { apiPatch, apiPost, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT, SHORT_TO_PLATFORM } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';

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

type Variant = { id: string; name: string; score: number; text: string; rationale?: string };

const DEFAULT_VARIANTS: Variant[] = [
  { id: 'A', name: 'Variant A · Conversational', score: 88, text: "Most founders I know are spending 6+ hours a week on social — and most of it is invisible work that doesn't compound.\n\nWe built Sociafy because the cost of being absent is finally higher than the cost of being mediocre.\n\nThree things changed our approach this quarter:" },
  { id: 'B', name: 'Variant B · Punchy', score: 92, text: "Stop posting. Start compounding.\n\n6 hours a week → 30 minutes.\nGuesswork → signal.\nSilence → conversations.\n\nSociafy isn't a scheduler. It's the agent that runs your content brain while you build the thing." },
  { id: 'C', name: 'Variant C · Story-led', score: 84, text: "Last March I missed a launch window because I forgot to schedule three posts.\n\n€48k of pipeline, gone. Not because the product wasn't ready — because I wasn't.\n\nThat's why we're shipping Sociafy. Here's what changed:" },
  { id: 'D', name: 'Variant D · Data-led', score: 79, text: "Founders who post 4+ times/week grow 3.2x faster than those who don't.\n\nThe problem: nobody can sustain that without burning out.\n\nWe trained an agent on 12k creator workflows to fix exactly this. Sociafy is now in private beta." },
];

type ImageSize = '1024x1024' | '1536x1024' | '1024x1536';
type ImageQuality = 'low' | 'medium' | 'high';
type VideoQuality = '480p' | '720p' | '1080p';
type VideoAspect = '9:16' | '1:1' | '16:9';
type VideoGenMode = 'text' | 'image-to-video' | 'reference' | 'audio-driven';

const VIDEO_GEN_MODES: { id: VideoGenMode; label: string; sub: string; icon: 'edit' | 'image' | 'grid' | 'bolt' }[] = [
  { id: 'text',           label: 'Text only',       sub: 'Just a prompt',           icon: 'edit'  },
  { id: 'image-to-video', label: 'Image → video',   sub: 'Start frame + prompt',    icon: 'image' },
  { id: 'reference',      label: 'Reference',       sub: 'Up to 9 refs + a video',  icon: 'grid'  },
  { id: 'audio-driven',   label: 'Audio-driven',    sub: 'Sync motion to a track',  icon: 'bolt'  },
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
  { id: 'yt', label: 'YouTube',   limit: 5000, full: 'youtube',   supports: { text: true,  image: true,  video: true  }, hint: {}, labelByMode: { text: 'YouTube Community', image: 'YouTube Community', video: 'YouTube Shorts' } },
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

const MediaPlaceholder: React.FC<MediaPlaceholderProps> = ({ kind, ratio = '16/9', count = 1, url, onUpload, onGenerate }) => {
  if (kind === 'video') {
    if (url) {
      return (
        <div style={{ aspectRatio: ratio, position: 'relative', background: '#000', overflow: 'hidden' }}>
          <video src={url} muted loop playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.92)', color: 'var(--ink)', display: 'grid', placeItems: 'center' }}>
              <Icon name="play" size={14} />
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
      <div style={{ aspectRatio: ratio, position: 'relative', background: 'var(--bg-sunk)', overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="post media" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
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

type PostProps = { text: string; mediaKind: string; mediaUrl?: string; onUpload?: () => void; onGenerate?: () => void; author: Author };

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

const PostX: React.FC<PostProps> = ({ text, mediaKind, mediaUrl, onUpload, onGenerate, author }) => (
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
            <MediaPlaceholder kind={mediaKind} ratio="16/9" url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} />
          </div>
        )}
      </div>
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--ink-4)', fontSize: 11, marginLeft: 46, fontFamily: 'var(--mono)' }}>
      <span>♡ —</span><span>↻ —</span><span>💬 —</span><span>↗ —</span>
    </div>
  </div>
);

const PostLI: React.FC<PostProps> = ({ text, mediaKind, mediaUrl, onUpload, onGenerate, author }) => (
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
    {mediaKind && <div style={{ marginTop: 10 }}><MediaPlaceholder kind={mediaKind} ratio="16/9" url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} /></div>}
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 8, display: 'flex', justifyContent: 'space-around', fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
      <span>👍 Like</span><span>💬 Comment</span><span>↻ Repost</span><span>↗ Send</span>
    </div>
  </div>
);

const PostIG: React.FC<{ text: string; mediaKind: string; mediaCount: number; mediaUrl?: string; onUpload?: () => void; onGenerate?: () => void; author: Author }> = ({ text, mediaKind, mediaCount, mediaUrl, onUpload, onGenerate, author }) => {
  const handle = (author.handle ?? author.name).toLowerCase().replace(/\s+/g, '');
  return (
    <div>
      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--line)' }}>
        <AvatarCircle author={author} size={28} gradient="linear-gradient(135deg, var(--ig), #FCAF45)" />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{handle}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--ink-4)' }}>•••</span>
      </div>
      <MediaPlaceholder kind={mediaKind || 'image'} ratio="1/1" count={mediaKind === 'carousel' ? mediaCount : 1} url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} />
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

const PostFB: React.FC<PostProps> = ({ text, mediaKind, mediaUrl, onUpload, onGenerate, author }) => (
  <div style={{ padding: '12px 14px' }}>
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <AvatarCircle author={author} size={36} gradient="var(--fb)" />
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{author.name}</div>
        <div style={{ fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>Just now · 🌐</div>
      </div>
    </div>
    <div style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: mediaKind ? 10 : 0 }}>{text}</div>
    {mediaKind && <MediaPlaceholder kind={mediaKind} ratio="4/3" url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} />}
  </div>
);

const PostTT: React.FC<{ text: string; mediaUrl?: string; onUpload?: () => void; onGenerate?: () => void; author: Author }> = ({ text, mediaUrl, onUpload, onGenerate, author }) => {
  const handle = (author.handle ?? author.name).toLowerCase().replace(/\s+/g, '');
  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 360, background: '#000' }}>
      {mediaUrl ? (
        <video src={mediaUrl} muted loop autoPlay playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : onUpload ? (
        <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, #111 0 8px, #181818 8px 16px)' }}>
          <UploadCTA kind="video" onClick={onUpload} onGenerate={onGenerate} dark />
        </div>
      ) : (
        <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, #111 0 8px, #181818 8px 16px)', display: 'grid', placeItems: 'center', color: '#fff8', fontFamily: 'var(--mono)', fontSize: 11 }}>
          [ vertical video ]
        </div>
      )}
      <div style={{ position: 'absolute', bottom: 60, left: 12, right: 70, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.5)', pointerEvents: 'none' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>@{handle}</div>
        <div style={{ fontSize: 11.5, lineHeight: 1.4, whiteSpace: 'pre-wrap', opacity: 0.95 }}>{text.slice(0, 90)}…</div>
      </div>
    </div>
  );
};

const PostYT: React.FC<PostProps> = ({ text, mediaKind, mediaUrl, onUpload, onGenerate, author }) => (
  <div>
    {mediaKind === 'video' ? (
      <div style={{ aspectRatio: '9/16', background: '#000', position: 'relative', overflow: 'hidden' }}>
        {mediaUrl ? (
          <video src={mediaUrl} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
        {mediaKind === 'image' && <MediaPlaceholder kind="image" ratio="16/9" url={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} />}
      </div>
    )}
  </div>
);

const PhonePreview: React.FC<{ platform: string; text: string; mediaKind: string; mediaCount: number; mediaUrl?: string; onUpload?: () => void; onGenerate?: () => void; author: Author }> = ({ platform, text, mediaKind, mediaCount, mediaUrl, onUpload, onGenerate, author }) => (
  <div className="phone">
    <div className="phone-screen">
      <div className="phone-statusbar">
        <span>9:41</span>
        <div className="icons"><span>•••</span><span>◊</span><span>▮</span></div>
      </div>
      {platform === 'x' && <PostX text={text} mediaKind={mediaKind} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} />}
      {platform === 'li' && <PostLI text={text} mediaKind={mediaKind} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} />}
      {platform === 'ig' && <PostIG text={text} mediaKind={mediaKind} mediaCount={mediaCount} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} />}
      {platform === 'fb' && <PostFB text={text} mediaKind={mediaKind} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} />}
      {platform === 'tt' && <PostTT text={text} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} />}
      {platform === 'yt' && <PostYT text={text} mediaKind={mediaKind} mediaUrl={mediaUrl} onUpload={onUpload} onGenerate={onGenerate} author={author} />}
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
  const [prompt, setPrompt] = useState('Announcement post for Sociafy private beta — talk about agentic content workflow, voice friendly, hopeful but grounded.');
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

  // Image generation state
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageSize, setImageSize] = useState<ImageSize>('1024x1024');
  const [imageQuality, setImageQuality] = useState<ImageQuality>('medium');
  const [imageCount, setImageCount] = useState<number>(2);
  const [imageBusy, setImageBusy] = useState(false);
  const [autoEnhance, setAutoEnhance] = useState<boolean>(true);

  // Video generation state.
  const [videoPrompt, setVideoPrompt] = useState('');
  const [videoCount, setVideoCount] = useState<number>(1);
  const [videoDuration, setVideoDuration] = useState<number>(8);
  const [videoQuality, setVideoQuality] = useState<VideoQuality>('720p');
  const [videoAspect, setVideoAspect] = useState<VideoAspect>('9:16');
  const [videoBusy, setVideoBusy] = useState(false);
  // Generation type picker + all the possible anchors.
  const [videoGenMode, setVideoGenMode] = useState<VideoGenMode>('text');
  const [startFrameUrl, setStartFrameUrl] = useState<string | null>(null);
  const [endFrameUrl, setEndFrameUrl] = useState<string | null>(null);
  const [referenceImageUrls, setReferenceImageUrls] = useState<string[]>([]);
  const [referenceVideoUrl, setReferenceVideoUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const refUploadRef = useRef<HTMLInputElement | null>(null);
  type AnchorTarget = 'start' | 'end' | 'reference' | 'refVideo' | 'audio';
  const [refUploadTarget, setRefUploadTarget] = useState<AnchorTarget | null>(null);

  const uploadAnchor = async (file: File): Promise<string | null> => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('label', `anchor-${file.name}`);
    const r = await fetch('/api/media/upload', { method: 'POST', body: fd, credentials: 'include' });
    if (!r.ok) {
      setToast(r.status === 503 ? 'Storage not configured.' : `Upload failed: ${r.status}`);
      return null;
    }
    const row = await r.json();
    return row.publicUrl as string;
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
      refUploadRef.current.click();
    }
  };

  const onFrameChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = refUploadTarget;
    e.target.value = '';
    if (!file || !target) return;
    const url = await uploadAnchor(file);
    if (!url) return;
    if (target === 'start') setStartFrameUrl(url);
    else if (target === 'end') setEndFrameUrl(url);
    else if (target === 'refVideo') setReferenceVideoUrl(url);
    else if (target === 'audio') setAudioUrl(url);
    else setReferenceImageUrls((cur) => [...cur, url].slice(0, 9));
    setRefUploadTarget(null);
  };

  /** The media item the user has marked as the "hero" for the preview. */
  const [selectedMediaIdx, setSelectedMediaIdx] = useState<number>(0);

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
    const p = imagePrompt.trim() || prompt.trim();
    if (!p) {
      setToast('Add a prompt for the image first.');
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
        }),
      });
      if (!r.ok) {
        if (r.status === 503) setToast('Image generation isn\'t configured yet. Check your AI + storage settings.');
        else if (r.status === 429) setToast('Slow down — too many image generations. Try again shortly.');
        else if (r.status === 401) setToast('Sign in to generate images.');
        else setToast(`Image generation failed: ${r.status}`);
        return;
      }
      const data = (await r.json()) as {
        items: Array<{ id: string; publicUrl: string; mimeType: string; label?: string }>;
        rewrittenPrompt?: string;
        enhanced?: boolean;
      };
      const added: MediaItem[] = data.items.map((row) => ({
        kind: 'image',
        label: row.label || p.slice(0, 60),
        tag: data.enhanced ? 'AI ✨' : 'AI',
        id: row.id,
        url: row.publicUrl,
        mimeType: row.mimeType,
      }));
      setMedia((m) => [...m, ...added]);
      // Auto-select the first newly generated image as hero
      setSelectedMediaIdx((modeMedia.length) + (mode === 'image' ? 0 : 0));
      setToast(
        data.enhanced
          ? `Generated ${added.length} · enhanced prompt: "${(data.rewrittenPrompt ?? '').slice(0, 90)}${(data.rewrittenPrompt ?? '').length > 90 ? '…' : ''}"`
          : `Generated ${added.length} image${added.length === 1 ? '' : 's'}.`,
      );
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(`Image generation failed: ${msg}`);
    } finally {
      setImageBusy(false);
    }
  };

  const generateVideo = async () => {
    const p = videoPrompt.trim() || prompt.trim();
    if (!p) {
      setToast('Describe the video first.');
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
          genMode: videoGenMode,
          startFrameUrl: startFrameUrl ?? undefined,
          endFrameUrl: endFrameUrl ?? undefined,
          referenceImageUrls: referenceImageUrls.length ? referenceImageUrls : undefined,
          referenceVideoUrl: referenceVideoUrl ?? undefined,
          audioUrl: audioUrl ?? undefined,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 503 && data?.error === 'video_provider_not_configured') {
        setToast(`AI video isn't configured yet. Rewritten prompt ready: "${(data.rewrittenPrompt ?? '').slice(0, 90)}…"`);
        return;
      }
      if (!r.ok && r.status !== 202) {
        if (r.status === 429) setToast('Slow down — too many video generations. Try again shortly.');
        else if (r.status === 401) setToast('Sign in to generate videos.');
        else setToast(`Video generation failed: ${r.status}`);
        return;
      }
      setToast(`Queued. Rewritten prompt: "${(data.rewrittenPrompt ?? '').slice(0, 90)}…" — webhook will drop the clip in your library when done.`);
      setTimeout(() => setToast(null), 5000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast(`Video generation failed: ${msg}`);
    } finally {
      setVideoBusy(false);
    }
  };

  const { data: accounts, unauth } = useApi<Account[]>('/api/accounts');
  const connectedShorts = useMemo(
    () => (accounts ?? []).map((a) => PLATFORM_TO_SHORT[a.platform]),
    [accounts],
  );

  // Load existing draft when editing
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

  // Default platform selection to whatever the user has connected (cap at 3)
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
    if (mode === 'video') tasks.push(generateVideo());
    await Promise.allSettled(tasks);
  };

  // The image/video "Describe X" section is now embedded INSIDE the main
  // Compose card (one card, one Generate button). These two helpers return
  // just the inner body — textarea + sliders — without their own card wrapper.
  const imageSection = (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon name="image" size={14} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 12, fontWeight: 550, letterSpacing: '-0.005em' }}>What&apos;s in the image?</span>
      </div>
      <textarea
        value={imagePrompt}
        onChange={(e) => setImagePrompt(e.target.value)}
        placeholder="Loose is fine — auto-enhance polishes it before generating."
        style={{
          width: '100%', minHeight: 56, padding: 10, fontSize: 13,
          border: '1px solid var(--line-2)', borderRadius: 8, background: 'var(--bg)',
          color: 'var(--ink)', fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5,
        }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>How many</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 2, 3, 4].map((n) => (
              <span
                key={n}
                className={`prompt-chip ${imageCount === n ? 'active' : ''}`}
                onClick={() => setImageCount(n)}
                style={{ minWidth: 28, justifyContent: 'center', textAlign: 'center' }}
              >
                {n}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Ratio</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {IMAGE_SIZE_OPTIONS.map((s) => (
              <span
                key={s.id}
                className={`prompt-chip ${imageSize === s.id ? 'active' : ''}`}
                onClick={() => setImageSize(s.id)}
                title={s.id}
              >
                {s.ratio}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Quality</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['low', 'medium', 'high'] as ImageQuality[]).map((q) => (
              <span
                key={q}
                className={`prompt-chip ${imageQuality === q ? 'active' : ''}`}
                onClick={() => setImageQuality(q)}
                title={q === 'low' ? 'Fastest' : q === 'high' ? 'Highest fidelity' : 'Balanced'}
              >
                {q}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const videoSection = (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon name="play" size={14} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 12, fontWeight: 550, letterSpacing: '-0.005em' }}>What&apos;s the clip about?</span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>
          {videoDuration}s · {videoQuality} · {videoAspect}
        </span>
      </div>
      <textarea
        value={videoPrompt}
        onChange={(e) => setVideoPrompt(e.target.value)}
        placeholder="Short description is enough — auto-enhance polishes it before generating."
        style={{
          width: '100%', minHeight: 56, padding: 10, fontSize: 13,
          border: '1px solid var(--line-2)', borderRadius: 8, background: 'var(--bg)',
          color: 'var(--ink)', fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5,
        }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>How many</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={`prompt-chip ${videoCount === n ? 'active' : ''}`}
                onClick={() => setVideoCount(n)}
                style={{ minWidth: 28, justifyContent: 'center', textAlign: 'center' }}
              >
                {n}
              </span>
            ))}
          </div>
        </div>
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
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Quality</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(['480p', '720p', '1080p'] as VideoQuality[]).map((q) => (
              <span
                key={q}
                className={`prompt-chip ${videoQuality === q ? 'active' : ''}`}
                onClick={() => setVideoQuality(q)}
              >
                {q}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Aspect</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(['9:16', '1:1', '16:9'] as VideoAspect[]).map((a) => (
              <span
                key={a}
                className={`prompt-chip ${videoAspect === a ? 'active' : ''}`}
                onClick={() => setVideoAspect(a)}
              >
                {a}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Generation type — drives which inputs render below. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>How to generate</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {VIDEO_GEN_MODES.map((m) => {
            const isActive = videoGenMode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setVideoGenMode(m.id)}
                style={{
                  textAlign: 'left', padding: '10px 12px', borderRadius: 10,
                  border: isActive ? '1px solid var(--ink)' : '1px solid var(--line)',
                  background: isActive ? 'var(--ink)' : 'var(--bg-elev)',
                  color: isActive ? 'var(--bg)' : 'var(--ink)',
                  cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon name={m.icon} size={11} />
                  <span style={{ fontSize: 11.5, fontWeight: 600 }}>{m.label}</span>
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
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Reference images ({referenceImageUrls.length}/9)</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                  {referenceImageUrls.map((url, i) => (
                    <div key={url + i} style={{ aspectRatio: '1/1', borderRadius: 6, border: '1px solid var(--line-2)', position: 'relative', overflow: 'hidden', background: 'var(--bg-sunk)' }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={`ref ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <button
                        onClick={() => setReferenceImageUrls((cur) => cur.filter((_, j) => j !== i))}
                        style={{ position: 'absolute', top: 2, right: 2, width: 14, height: 14, borderRadius: 3, background: 'rgba(10,10,10,0.7)', color: 'white', border: 0, display: 'grid', placeItems: 'center', cursor: 'pointer' }}
                      >
                        <Icon name="x" size={8} />
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
                      onClick={() => setReferenceVideoUrl(null)}
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
      if (r.stub) {
        setToast('Running in demo mode — connect an AI provider for real generation.');
      } else if (opts?.withTools && r.toolsUsed?.length) {
        setToast(`Researched with ${r.toolsUsed.join(' + ')} before drafting.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('401') || msg.startsWith('503')) {
        setToast('Sign in to generate real variants.');
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
  // mode (e.g. switching to Text drops Instagram).
  useEffect(() => {
    setPlatforms((prev) => {
      const filtered = prev.filter((p) => PLATFORM_BY_SHORT[p]?.supports[mode]);
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [mode]);

  const persistDraft = async () => {
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
      if (ok.length > 0 && failed.length === 0) {
        const urls = ok.filter((res) => res.url).map((res) => `${res.platform}: ${res.url}`).join('  ·  ');
        setToast(`Published to ${ok.map((res) => res.platform).join(', ')}${urls ? ` — ${urls}` : ''}`);
        setTimeout(() => onDone?.(), 1200);
      } else if (ok.length > 0 && failed.length > 0) {
        setToast(`Partial: published to ${ok.map((res) => res.platform).join(', ')}; failed on ${failed.map((res) => `${res.platform} (${res.error})`).join(', ')}`);
      } else {
        setToast(`Publish failed: ${failed.map((res) => `${res.platform}: ${res.error}`).join('; ')}`);
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
      <div className="composer-left">
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
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
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
            placeholder={mode === 'video'
              ? 'What should the caption say? The reel script preset works great here.'
              : 'Write a thread about why solo founders should treat their newsletter as their #1 channel…'}
          />

          {/* Mode-specific second section — image or video prompt + controls.
              All in the same card so the user has ONE Generate button below. */}
          {mode === 'image' && imageSection}
          {mode === 'video' && videoSection}

          <div className="prompt-foot">
            <div className="prompt-chips">
              {COMPOSE_PRESETS.filter((p) => p.modes.includes(mode)).map((p) => (
                <span
                  key={p.id}
                  className={`prompt-chip ${preset === p.id ? 'active' : ''}`}
                  onClick={() => setPreset(p.id)}
                >
                  {p.label}
                </span>
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
              disabled={generating || imageBusy || videoBusy || !prompt.trim()}
            >
              {(generating || imageBusy || videoBusy)
                ? <><Icon name="refresh" size={12} /> {withResearch ? 'Researching' : 'Generating'}</>
                : <><Icon name="sparkle" size={12} />
                    {mode === 'text' && 'Generate 4 variants'}
                    {mode === 'image' && `Generate post${imageCount > 1 ? ` + ${imageCount} images` : ' + image'}`}
                    {mode === 'video' && `Generate post${videoCount > 1 ? ` + ${videoCount} clips` : ' + clip'}`}
                  </>}
            </button>
          </div>
        </div>

        {toast && (
          <div style={{ padding: 12, fontSize: 12.5, background: 'rgba(124,77,255,0.06)', border: '1px solid rgba(124,77,255,0.2)', borderRadius: 10, marginBottom: 12 }}>
            {toast}
          </div>
        )}
        {unauth && (
          <div style={{ padding: 12, fontSize: 12.5, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 12 }}>
            <strong>Demo mode.</strong> <a href="/sign-in?next=/dashboard" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>Sign in</a> to generate, draft, and schedule for real.
          </div>
        )}

        <div className="card">
          <div className="card-head">
            <h3><Icon name="globe" size={14} /> Distribution</h3>
            <span className="meta">{platforms.length} platforms · adapts per channel</span>
          </div>
          <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
                <span
                  key={p.id}
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
                </span>
              );
            })}
            <div style={{ flex: 1 }} />
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
              disabled={busy !== null}
              onClick={() => customSchedule ? schedule(new Date(customSchedule).toISOString()) : scheduleIn30()}
            >
              <Icon name="clock" size={12} /> {busy === 'schedule' ? 'Scheduling…' : customSchedule ? 'Schedule' : 'Schedule (+30m)'}
            </button>
            <button className="btn sm primary" disabled={busy !== null} onClick={postNow}>
              <Icon name="send" size={12} /> {busy === 'post' ? 'Posting…' : 'Post now'}
            </button>
          </div>
        </div>

        {/* Variants only make sense for caption-heavy posts. Video posts get
            ONE caption that pairs with the clip — multiple variants would be
            noise. */}
        {mode !== 'video' && (
        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="fork" size={14} />
              Variants
              <span className="chip ghost mono">{variants.length} {variants.length === 1 ? 'variant' : 'variants'}</span>
            </h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm ghost" onClick={() => generate()} disabled={generating}><Icon name="refresh" size={12} /> Regenerate</button>
            </div>
          </div>
          <div className="card-body">
            <div className="variants">
              {variants.map((v) => (
                <div
                  key={v.id}
                  className={`variant ${active === v.id ? 'active' : ''}`}
                  onClick={() => setActive(v.id)}
                >
                  <div className="variant-head">
                    <span className="variant-name">{v.name}</span>
                    <span className="variant-meta">
                      <Icon name={v.score >= 85 ? 'fire' : 'chart'} size={11} style={{ verticalAlign: -1 }} /> {v.score}
                    </span>
                  </div>
                  {active === v.id ? (
                    <textarea
                      className="variant-text"
                      value={v.text}
                      onChange={(e) => {
                        const next = e.target.value;
                        setVariants((cur) => cur.map((x) => x.id === v.id ? { ...x, text: next } : x));
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: '100%', minHeight: 90, padding: 8, fontSize: 13.5,
                        background: 'var(--bg)', border: '1px solid var(--line-2)', borderRadius: 6,
                        outline: 'none', color: 'var(--ink)', fontFamily: 'inherit', resize: 'vertical',
                        lineHeight: 1.5,
                      }}
                    />
                  ) : (
                    <div className="variant-text">{v.text}</div>
                  )}
                  {v.rationale && (
                    <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4, fontStyle: 'italic' }}>{v.rationale}</div>
                  )}
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn sm" onClick={(e) => { e.stopPropagation(); setActive(v.id); }}>
                      <Icon name="check" size={11} /> {active === v.id ? 'Selected' : 'Use'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        )}

        {/* === IMAGE MODE — output gallery (the input card sits above Distribution) === */}
        {mode === 'image' && (
          <>
            <div className="card">
              <div className="card-head">
                <h3><Icon name="image" size={14} /> Your images <span className="chip ghost mono">{modeMedia.length}</span></h3>
                <div className="media-tabs">
                  {(['image', 'carousel'] as MediaKind[]).map((k) => (
                    <span key={k} className={`opt ${mediaKind === k ? 'active' : ''}`} onClick={() => setMediaKind(k)}>
                      <Icon name={k === 'image' ? 'image' : 'grid'} size={11} />
                      {k.charAt(0).toUpperCase() + k.slice(1)}
                    </span>
                  ))}
                </div>
              </div>
              <div className="card-body">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
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
                        <button
                          onClick={(e) => { e.stopPropagation(); setMedia(media.filter((it) => it !== m)); }}
                          style={{ position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 4, background: 'rgba(10,10,10,0.6)', color: 'white', display: 'grid', placeItems: 'center', border: 0, cursor: 'pointer' }}
                          aria-label="Remove image"
                        >
                          <Icon name="x" size={10} />
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
          <div className="card">
            <div className="card-head">
              <h3><Icon name="play" size={14} /> Your video <span className="chip ghost mono">{modeMedia.length}</span></h3>
            </div>
            <div className="card-body">
              <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line-2)', background: '#000', aspectRatio: '16/9' }}>
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
                        onClick={(e) => { e.stopPropagation(); setMedia(media.filter((it) => it !== m)); }}
                        style={{ position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: 4, background: 'rgba(10,10,10,0.7)', color: 'white', display: 'grid', placeItems: 'center', border: 0, cursor: 'pointer' }}
                        aria-label="Remove clip"
                      >
                        <Icon name="x" size={9} />
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
            <span className="meta mono">{charCount} / {limit}</span>
          </div>
          <div className="card-body">
            <div className="preview-tabs" style={{ marginBottom: 16 }}>
              {platforms.map((p) => (
                <div
                  key={p}
                  className={`preview-tab ${previewPlat === p ? 'active' : ''}`}
                  onClick={() => setPreviewPlat(p)}
                  title={PLATFORM_BY_SHORT[p] ? platformLabel(PLATFORM_BY_SHORT[p], mode) : p}
                >
                  <Pglyph p={p} />
                </div>
              ))}
            </div>
            <PhonePreview
              platform={previewPlat}
              text={variant?.text ?? ''}
              mediaKind={mode === 'text' ? '' : mediaKind}
              mediaCount={media.length}
              mediaUrl={mode === 'text' ? undefined : currentMediaUrl}
              onUpload={mode !== 'text' && !currentMediaUrl ? onPickFile : undefined}
              onGenerate={mode === 'image' && !currentMediaUrl
                ? generateImage
                : mode === 'video' && !currentMediaUrl
                  ? generateVideo
                  : undefined}
              author={previewAuthor}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

function minDateTimeLocal(): string {
  const d = new Date(Date.now() + 60 * 1000); // can't pick the past
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default Compose;
