'use client';

import React, { useRef } from 'react';
import Link from 'next/link';
import { Icon } from '../icons';
import { VoicePicker } from '../voice-studio';
import { priceForImage } from '../../lib/credits/pricing';
import { MOTION_GRAPHICS, MOTION_TEMPLATE_IDS, MOTION_TEMPLATES, VIDEO_MODELS } from '../../lib/ai/models';
import { motionReady, type BrandKit, type BrandProfile } from '../../lib/brand/kit';
import { useApi } from '../../lib/ui/fetcher';
import { videoDuration, videoModel, type Anchor, type MediaGen, type VideoMode } from './generate';

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
  { id: 'motion', label: 'Motion graphic (uses your brand kit)' },
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
        <button type="button" className="btn sm" onClick={onPick}><Icon name="upload" size={12} /> Upload</button>
      )}
    </div>
  );
}

export function MoreOptions({
  gen, preset, setPreset, research, setResearch, attachedImages,
}: {
  gen: MediaGen;
  preset: string;
  setPreset: (p: string) => void;
  research: boolean;
  setResearch: (v: boolean) => void;
  attachedImages: number;
}) {
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
  // `motion` is the server's feature flag; without it the option doesn't exist.
  const { data: brand } = useApi<{ kit: BrandKit; profile: BrandProfile; motion?: boolean }>('/api/brand-kit');
  const modes = VIDEO_MODES.filter((m) => m.id !== 'motion' || brand?.motion);
  const refSurcharge = priceForImage(s.imageSize, s.imageQuality, 1).surcharge;

  return (
    <div className="compose-more-body">
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

      <section className="stack">
        <h3 className="compose-subhead">Writing</h3>
        <div className="compose-chips" role="group" aria-label="Format">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className={`prompt-chip${preset === p.id ? ' active' : ''}`} aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <label className="compose-check">
          <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} />
          Research the web and your past posts first <span className="compose-note">slower, costs more</span>
        </label>
      </section>

      <section className="stack">
        <h3 className="compose-subhead">Image</h3>
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
      </section>

      <section className="stack">
        <h3 className="compose-subhead">Video</h3>
        <div className="compose-grid">
          <Field label="Made from">
            <select className="input" value={s.videoMode} onChange={(e) => {
              const videoMode = e.target.value as VideoMode;
              set({ videoMode, ...(videoMode === 'motion' && s.videoAspect === '1:1' ? { videoAspect: '9:16' as const } : {}) });
            }}>
              {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Field>
          {!motion && <Field label="Quality">
            <select className="input" value={s.videoQuality} onChange={(e) => set({ videoQuality: e.target.value as typeof s.videoQuality })}>
              <option value="480p">480p</option>
              <option value="720p">720p</option>
              {!avatar && <option value="1080p">1080p</option>}
            </select>
          </Field>}
          <Field label="Shape">
            <select className="input" value={s.videoAspect} onChange={(e) => set({ videoAspect: e.target.value as typeof s.videoAspect })}>
              <option value="9:16">Vertical 9:16</option>
              {!motion && <option value="1:1">Square 1:1</option>}
              <option value="16:9">Wide 16:9</option>
            </select>
          </Field>
          {!avatar && !motion && (
            <Field label={`Length · ${videoDuration(s)}s`}>
              <input type="range" min={model.durationSec.min} max={model.durationSec.max} value={videoDuration(s)} onChange={(e) => set({ videoDuration: Number(e.target.value) })} />
            </Field>
          )}
          {!avatar && !motion && (
            <Field label="How many">
              <select className="input" value={s.videoCount} onChange={(e) => set({ videoCount: Number(e.target.value) })}>
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
          )}
        </div>
        {motion && (
          <div className="stack">
            <div className="compose-chips" role="group" aria-label="Template">
              {MOTION_TEMPLATE_IDS.map((t) => (
                <button key={t} type="button" className={`prompt-chip${s.motionTemplate === t ? ' active' : ''}`} aria-pressed={s.motionTemplate === t} onClick={() => set({ motionTemplate: t })}>
                  {MOTION_TEMPLATES[t].label} · {MOTION_TEMPLATES[t].durationSec}s
                </button>
              ))}
            </div>
            {brand && !motionReady(brand.kit, brand.profile) ? (
              <p className="compose-error">Needs your brand name, logo and main color. <Link href="/settings/brand">Open Brand kit</Link></p>
            ) : (
              <p className="compose-note">Renders on {MOTION_GRAPHICS.name} from your brand kit — silent, usually under two minutes.</p>
            )}
          </div>
        )}

        {!avatar && !motion && (
          <>
            <label className="compose-check">
              <input type="checkbox" checked={s.videoFast} onChange={(e) => set({ videoFast: e.target.checked })} />
              Faster and cheaper, no sound
            </label>
            <p className="compose-note">Renders on {model.name}{model.nativeAudio ? ' — with sound' : ' — silent'}.</p>
          </>
        )}

        {s.videoMode === 'image-to-video' && (
          <div className="compose-grid">
            <Slot label="Start frame" url={s.startFrame} kind="image" onPick={() => pick('start')} onClear={() => set({ startFrame: null })} />
            <Slot label="End frame (optional)" url={s.endFrame} kind="image" onPick={() => pick('end')} onClear={() => set({ endFrame: null })} />
          </div>
        )}

        {s.videoMode === 'reference' && (
          <div className="stack">
            <span className="compose-label">Reference images ({s.refImages.length}/9)</span>
            <div className="compose-strip">
              {s.refImages.map((u, i) => (
                <div key={u + i} className="compose-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt={`Reference ${i + 1}`} />
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
      </section>
    </div>
  );
}
