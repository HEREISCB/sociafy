'use client';

import React, { useRef } from 'react';
import Link from 'next/link';
import { Icon } from '../icons';
import { VoicePicker } from '../voice-studio';
import { priceForImage } from '../../lib/credits/pricing';
import { MOTION_AI, MOTION_GRAPHICS, MOTION_TEMPLATE_IDS, MOTION_TEMPLATES, VIDEO_MODELS, VIDEO_MODEL_IDS, type VideoModelId } from '../../lib/ai/models';
import { motionAiReady, motionReady, type BrandKit, type BrandProfile } from '../../lib/brand/kit';
import { useApi } from '../../lib/ui/fetcher';
import { ThumbImg } from '../thumb-img';
import { cinemaBlockers, FAST_MAX_SEC, fastOn, videoDuration, videoModel, type Anchor, type MediaGen, type VideoMode } from './generate';

/** The presets /api/compose/variants understands (PRESET_KEYS in its route). */
export const PRESETS = [
  { id: 'announcement', label: 'Announcement' },
  { id: 'thread', label: 'Thread' },
  { id: 'recap', label: 'Recap' },
  { id: 'hot-take', label: 'Hot take' },
  { id: 'lesson', label: 'Lesson' },
  { id: 'reel', label: 'Reel script' },
] as const;

const VIDEO_MODES: { id: VideoMode; label: string }[] = [
  { id: 'text', label: 'From the post' },
  { id: 'image-to-video', label: 'From a start frame' },
  { id: 'reference', label: 'From reference images' },
  { id: 'audio-driven', label: 'Synced to audio' },
  { id: 'avatar', label: 'Talking avatar' },
];

const ACCEPT: Record<Anchor, string> = {
  start: 'image/png,image/jpeg,image/webp',
  end: 'image/png,image/jpeg,image/webp',
  reference: 'image/png,image/jpeg,image/webp',
  avatarFace: 'image/png,image/jpeg,image/webp',
  refVideo: 'video/mp4,video/webm,video/quicktime',
  audio: 'audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm,audio/m4a,audio/x-m4a,audio/aac',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="compose-field">
      <span className="compose-label">{label}</span>
      {children}
    </label>
  );
}

/** One uploaded input (frame, clip, audio). */
function Slot({ label, url, kind, onPick, onClear }: { label: string; url: string | null; kind: 'image' | 'video' | 'audio'; onPick: () => void; onClear: () => void }) {
  return (
    <div className="compose-field">
      <span className="compose-label">{label}</span>
      {url ? (
        <div className="compose-slot">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {kind === 'image' ? <img src={url} alt={label} /> : kind === 'video' ? <video src={url} muted playsInline /> : <audio src={url} controls />}
          <button type="button" className="btn ghost sm" onClick={onClear} aria-label={`Remove ${label}`}><Icon name="x" size={11} /></button>
        </div>
      ) : (
        <button type="button" className="btn sm compose-self-start" onClick={onPick}><Icon name="upload" size={12} /> Upload</button>
      )}
    </div>
  );
}

/** The primary action at the foot of a media panel. */
function GenerateButton({ what, busy, cost, disabled, onClick, reasonId }: { what: 'image' | 'video' | 'motion graphic'; busy: boolean; cost: number | null; disabled: boolean; onClick: () => void; reasonId?: string }) {
  return (
    <button type="button" className="btn primary compose-self-start" disabled={disabled} onClick={onClick} aria-describedby={reasonId}>
      <Icon name="sparkle" size={12} /> {busy ? `Making ${what}…` : `Generate ${what}`}
      <span className="compose-cost">{cost === null ? 'priced on submit' : `${cost} cr`}</span>
    </button>
  );
}

type PanelProps = { gen: MediaGen; cost: number | null; disabled: boolean; onGenerate: () => void };

export function ImageOptions({ gen, cost, disabled, onGenerate, attachedImages }: PanelProps & { attachedImages: number }) {
  const { s, set } = gen;
  const refSurcharge = priceForImage(s.imageSize, s.imageQuality, 1).surcharge;
  return (
    <div className="compose-media-panel">
      <div className="compose-grid">
        <Field label="Shape">
          <select className="input" value={s.imageSize} onChange={(e) => set({ imageSize: e.target.value as typeof s.imageSize })}>
            <option value="1024x1024">Square</option>
            <option value="1536x1024">Landscape</option>
            <option value="1024x1536">Portrait</option>
          </select>
        </Field>
        <Field label="Quality">
          <select className="input" value={s.imageQuality} onChange={(e) => set({ imageQuality: e.target.value as typeof s.imageQuality })}>
            <option value="low">Draft</option>
            <option value="medium">Standard</option>
            <option value="high">High</option>
          </select>
        </Field>
        <Field label="How many">
          <select className="input" value={s.imageCount} onChange={(e) => set({ imageCount: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      </div>
      <label className="compose-check">
        <input type="checkbox" checked={s.attachedAsRefs} onChange={(e) => set({ attachedAsRefs: e.target.checked })} />
        Match the attached images{attachedImages ? ` (${attachedImages})` : ''} <span className="compose-note">+{refSurcharge} credits each</span>
      </label>
      <label className="compose-check">
        <input type="checkbox" checked={s.autoEnhance} onChange={(e) => set({ autoEnhance: e.target.checked })} />
        Improve my description before generating
      </label>
      <GenerateButton what="image" busy={gen.busy === 'image'} cost={cost} disabled={disabled} onClick={onGenerate} />
    </div>
  );
}

export function VideoOptions({ gen, cost, disabled, onGenerate }: PanelProps) {
  const { s, set } = gen;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const target = useRef<Anchor | null>(null);
  const pick = (a: Anchor) => {
    target.current = a;
    if (fileRef.current) { fileRef.current.accept = ACCEPT[a]; fileRef.current.click(); }
  };
  const model = VIDEO_MODELS[videoModel(s)];
  const avatar = s.videoMode === 'avatar';
  const motion = s.videoMode === 'motion';
  const aiMotion = motion && s.motionAi;
  const prompted = !avatar && !motion;
  const wantsCinema = s.videoModel === 'sociafy-cinema-1';
  const blockers = cinemaBlockers(s);
  const motionOnly = wantsCinema ? ' (Motion only)' : '';
  // `motion` / `motionAi` are the server's feature flags; without them the option doesn't exist.
  const { data: brand } = useApi<{ kit: BrandKit; profile: BrandProfile; motion?: boolean; motionAi?: boolean }>('/api/brand-kit');
  const motionKinds = [
    { ai: false, label: 'Templates', on: Boolean(brand?.motion) },
    { ai: true, label: 'AI-designed', on: Boolean(brand?.motionAi) },
  ];
  const anyMotion = motionKinds.some((k) => k.on);
  // Same readiness rules the server applies (lib/media/motionJob.ts): the warning is the reason Generate is off.
  const brandBlocked = Boolean(motion && brand && !(aiMotion ? motionAiReady : motionReady)(brand.kit, brand.profile));
  // Templates render 9:16 / 16:9 only; square falls back to vertical.
  const pickMotion = (ai: boolean) => set({ videoMode: 'motion', motionAi: ai, ...(!ai && s.videoAspect === '1:1' ? { videoAspect: '9:16' as const } : {}) });

  return (
    <div className="compose-media-panel">
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f && target.current) void gen.setAnchor(target.current, f);
        }}
      />

      <div className="compose-field">
        <span className="compose-label">Kind</span>
        <div className="mode-switch compose-self-start" role="radiogroup" aria-label="Kind">
          <button type="button" role="radio" aria-checked={!motion} className={`opt${!motion ? ' active' : ''}`} onClick={() => motion && set({ videoMode: 'text' })}>AI video</button>
          <button type="button" role="radio" aria-checked={motion} className={`opt${motion ? ' active' : ''}`} disabled={!anyMotion} onClick={() => !motion && pickMotion(!brand?.motion)}>Motion graphics</button>
        </div>
        {brand && !anyMotion && <p className="compose-note">Motion graphics aren’t switched on for your account yet.</p>}
      </div>

      {motion && (
        <div className="compose-field">
          <span className="compose-label">Style</span>
          <div className="mode-switch compose-self-start" role="radiogroup" aria-label="Motion graphic style">
            {motionKinds.map((k) => (
              <button key={k.label} type="button" role="radio" aria-checked={s.motionAi === k.ai} className={`opt${s.motionAi === k.ai ? ' active' : ''}`} disabled={!k.on} title={k.on ? undefined : 'Not switched on for your account'} onClick={() => pickMotion(k.ai)}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!motion && <div className="compose-field">
        <span className="compose-label">Made from</span>
        <div className="compose-chips" role="radiogroup" aria-label="Made from">
          {VIDEO_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={s.videoMode === m.id}
              className={`prompt-chip${s.videoMode === m.id ? ' active' : ''}`}
              onClick={() => set({ videoMode: m.id })}
            >
              {m.label}{m.id === 'reference' ? motionOnly : ''}
            </button>
          ))}
        </div>
      </div>}

      {prompted && (
        <div className="compose-field">
          <span className="compose-label">Model</span>
          <div className="mode-switch compose-self-start" role="radiogroup" aria-label="Model">
            {VIDEO_MODEL_IDS.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={s.videoModel === id} className={`opt${s.videoModel === id ? ' active' : ''}`} onClick={() => set({ videoModel: id as VideoModelId })}>
                {VIDEO_MODELS[id].name}
              </button>
            ))}
          </div>
          <p className="compose-note">{VIDEO_MODELS[s.videoModel].summary}</p>
          {wantsCinema && blockers.length > 0 && (
            <p className="compose-note compose-error">
              {VIDEO_MODELS['sociafy-cinema-1'].name} can&apos;t do {blockers.join(' or ')} — this renders on {VIDEO_MODELS['sociafy-motion-1'].name}, without sound.
            </p>
          )}
        </div>
      )}

      {s.videoMode === 'image-to-video' && (
        <div className="compose-grid">
          <Slot label={model.endFrameAlone ? 'Start frame (optional)' : 'Start frame'} url={s.startFrame} kind="image" onPick={() => pick('start')} onClear={() => set({ startFrame: null })} />
          <Slot label="End frame (optional)" url={s.endFrame} kind="image" onPick={() => pick('end')} onClear={() => set({ endFrame: null })} />
        </div>
      )}

      {s.videoMode === 'reference' && (
        <div className="stack">
          <span className="compose-label">Reference images ({s.refImages.length}/9)</span>
          <div className="compose-strip">
            {s.refImages.map((u, i) => (
              <div key={u + i} className="compose-thumb">
                <ThumbImg src={u} alt={`Reference ${i + 1}`} size={96} />
                <button type="button" className="compose-thumb-x" aria-label={`Remove reference ${i + 1}`} onClick={() => set({ refImages: s.refImages.filter((_, j) => j !== i) })}>
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
            {s.refImages.length < 9 && (
              <button type="button" className="compose-thumb compose-thumb-add" aria-label="Add reference image" onClick={() => pick('reference')}>
                <Icon name="plus" size={14} />
              </button>
            )}
          </div>
          <Slot label="Reference clip (optional)" url={s.refVideo} kind="video" onPick={() => pick('refVideo')} onClear={() => set({ refVideo: null, refVideoSec: null })} />
          {s.refVideo && (
            <p className={s.refVideoSec == null || s.refVideoSec > 60 ? 'compose-error' : 'compose-note'}>
              {s.refVideoSec == null ? 'Could not read its length — re-upload as MP4 or MOV.' : s.refVideoSec > 60 ? 'Clips over 60s are not accepted.' : `${Math.round(s.refVideoSec)}s clip — its length is billed too.`}
            </p>
          )}
        </div>
      )}

      {s.videoMode === 'audio-driven' && (
        <Slot label="Audio track" url={s.audio} kind="audio" onPick={() => pick('audio')} onClear={() => set({ audio: null })} />
      )}

      {avatar && (
        <div className="stack">
          <Slot label={`Face photo · cropped to ${s.videoAspect}`} url={s.avatarFace} kind="image" onPick={() => pick('avatarFace')} onClear={() => set({ avatarFace: null })} />
          <div className="compose-chips" role="group" aria-label="Avatar voice">
            <button type="button" className={`prompt-chip${s.avatarAudioMode === 'voice' ? ' active' : ''}`} aria-pressed={s.avatarAudioMode === 'voice'} onClick={() => set({ avatarAudioMode: 'voice' })}>My voice</button>
            <button type="button" className={`prompt-chip${s.avatarAudioMode === 'audio' ? ' active' : ''}`} aria-pressed={s.avatarAudioMode === 'audio'} onClick={() => set({ avatarAudioMode: 'audio' })}>Upload audio</button>
          </div>
          {s.avatarAudioMode === 'voice' ? (
            <>
              <VoicePicker value={s.avatarVoiceId} onChange={(id) => set({ avatarVoiceId: id })} />
              <textarea className="input" rows={3} maxLength={2000} placeholder="What should the avatar say?" value={s.avatarScript} onChange={(e) => set({ avatarScript: e.target.value })} />
              <div className="row">
                <button type="button" className="btn sm" disabled={gen.voicePreview.busy || !(s.avatarVoiceId && s.avatarScript.trim())} onClick={gen.previewVoice}>
                  <Icon name="play" size={11} /> {gen.voicePreview.busy ? 'Synthesizing…' : 'Hear it'}
                </button>
                {gen.voicePreview.url && <audio src={gen.voicePreview.url} controls />}
              </div>
            </>
          ) : (
            <Slot label="Audio track" url={s.audio} kind="audio" onPick={() => pick('audio')} onClear={() => set({ audio: null })} />
          )}
        </div>
      )}

      {motion && !aiMotion && (
        <div className="stack">
          <div className="compose-chips" role="group" aria-label="Template">
            {MOTION_TEMPLATE_IDS.map((t) => (
              <button key={t} type="button" className={`prompt-chip${s.motionTemplate === t ? ' active' : ''}`} aria-pressed={s.motionTemplate === t} onClick={() => set({ motionTemplate: t })}>
                {MOTION_TEMPLATES[t].label} · {MOTION_TEMPLATES[t].durationSec}s
              </button>
            ))}
          </div>
          {brandBlocked && (
            <p id="motion-brand-reason" className="compose-error">Needs your brand name, logo and main color. <Link href="/settings/brand">Open Brand kit</Link></p>
          )}
        </div>
      )}

      {aiMotion && brandBlocked && (
        <p id="motion-brand-reason" className="compose-error">Needs your brand name and main color. <Link href="/settings/brand">Open Brand kit</Link></p>
      )}

      <div className="compose-grid">
        {!motion && <Field label="Quality">
          <select className="input" value={s.videoQuality} onChange={(e) => set({ videoQuality: e.target.value as typeof s.videoQuality })}>
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            {!avatar && <option value="1080p">1080p{motionOnly}</option>}
          </select>
        </Field>}
        <Field label="Shape">
          <select className="input" value={s.videoAspect} onChange={(e) => set({ videoAspect: e.target.value as typeof s.videoAspect })}>
            <option value="9:16">Vertical 9:16</option>
            {(!motion || aiMotion) && <option value="1:1">Square 1:1</option>}
            <option value="16:9">Wide 16:9</option>
          </select>
        </Field>
        {prompted && (
          <Field label="How many">
            <select className="input" value={s.videoCount} onChange={(e) => set({ videoCount: Number(e.target.value) })}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
        )}
      </div>

      {aiMotion && (
        <div className="compose-field" role="group" aria-label="Sound">
          <span className="compose-label">Sound</span>
          <label className="compose-check">
            <input type="checkbox" checked={s.motionAiVoiceover} onChange={(e) => set({ motionAiVoiceover: e.target.checked })} />
            Voiceover <span className="compose-note">{s.motionAiMusic ? 'no extra with music' : '+4 cr/s'}</span>
          </label>
          {s.motionAiVoiceover && (
            <select className="input compose-self-start" aria-label="Voiceover language" value={s.motionAiLanguage} onChange={(e) => set({ motionAiLanguage: e.target.value as typeof s.motionAiLanguage })}>
              <option value="en">English</option>
              <option value="hi">Hindi</option>
            </select>
          )}
          <label className="compose-check">
            <input type="checkbox" checked={s.motionAiSfx} onChange={(e) => set({ motionAiSfx: e.target.checked })} />
            Sound effects <span className="compose-note">free</span>
          </label>
          <label className="compose-check">
            <input type="checkbox" checked={s.motionAiMusic} onChange={(e) => set({ motionAiMusic: e.target.checked })} />
            Music <span className="compose-note">{s.motionAiVoiceover ? 'no extra with voiceover' : '+4 cr/s'}</span>
          </label>
        </div>
      )}

      {prompted && (
        <>
          <label className="compose-check">
            <input type="checkbox" checked={fastOn(s)} disabled={s.videoDuration > FAST_MAX_SEC} onChange={(e) => set({ videoFast: e.target.checked })} />
            Fast render — quicker and cheaper{motionOnly} <span className="compose-note">{s.videoDuration > FAST_MAX_SEC ? `up to ${FAST_MAX_SEC}s, so this length renders on quality` : '480p and 720p only'}</span>
          </label>
          <label className="compose-check">
            <input type="checkbox" checked={s.autoEnhance} onChange={(e) => set({ autoEnhance: e.target.checked })} />
            Improve my description before generating
          </label>
        </>
      )}

      <p className="compose-note">
        {avatar ? 'Talking avatar — lip-synced to the voice or audio you pick.'
          : aiMotion ? 'Designed from your post text and brand kit — takes a few minutes.'
          : motion ? `Renders on ${MOTION_GRAPHICS.name} from your brand kit — silent, usually under two minutes.`
          : `Renders on ${model.name}${model.nativeAudio ? ' — with sound' : ' — silent'}${fastOn(s) && s.videoQuality !== '1080p' ? ', fast render' : ''}.`}
      </p>
      <GenerateButton
        what={motion ? 'motion graphic' : 'video'} busy={gen.busy === 'video'} cost={cost}
        disabled={disabled || brandBlocked} onClick={onGenerate} reasonId={brandBlocked ? 'motion-brand-reason' : undefined}
      />
    </div>
  );
}

/**
 * The one Length control for video, shared by Auto and Custom (and the chat,
 * and From a website). The left end means the AI decides (Auto) or the
 * model's default (Custom); Custom clamps to what the picked engine renders.
 */
export function LengthControl({ gen, length, setLength }: { gen: MediaGen; length: number | null; setLength: (n: number | null) => void }) {
  const { s } = gen;
  const { min, max } = MOTION_AI.durationSec;
  const auto = s.videoSmart;
  const template = MOTION_TEMPLATES[s.motionTemplate];
  const fixed = auto ? null
    : s.videoMode === 'avatar' ? 'An avatar runs as long as its script or audio.'
    : s.videoMode === 'motion' && !s.motionAi ? `The ${template.label} template runs ${template.durationSec}s.`
    : null;
  const motion = s.videoMode === 'motion';
  const effective = auto ? length : motion ? s.motionAiDuration : videoDuration(s);
  const model = VIDEO_MODELS[videoModel(s)];
  const note = fixed ?? (!auto && !motion && length && effective !== length
    ? `${model.name} renders ${model.durationSec.min}–${model.durationSec.max}s, so this clip is ${effective}s.`
    : null);
  // An edit's length is the editor's call too unless the user picks one (FootageOptions shows the cap).
  const shown = fixed ? 'Fixed' : length ? `${length}s` : auto || s.videoMode === 'footage' ? 'AI decides' : `Default ${effective}s`;
  return (
    <div className="compose-field">
      <label className="compose-length">
        <span className="compose-label">Length</span>
        <input
          type="range" min={min - 1} max={max} step={1} value={length ?? min - 1} disabled={Boolean(fixed)}
          aria-valuetext={shown} aria-describedby={note ? 'compose-length-note' : undefined}
          onChange={(e) => { const n = Number(e.target.value); setLength(n >= min ? n : null); }}
        />
        <output className="tnum">{shown}</output>
      </label>
      {note && <p id="compose-length-note" className="compose-note">{note}</p>}
    </div>
  );
}
