'use client';

import React, { useRef } from 'react';
import { Icon } from '../icons';
import { Button } from '../ui';
import { useApi } from '../../lib/ui/fetcher';
import { FOOTAGE_EDIT, motionAiExtraMin } from '../../lib/ai/models';
import { footageEditCap, priceForFootageEdit } from '../../lib/credits/pricing';
import type { MediaGen, RawClip } from './generate';

/** One-tap asks; each adds its sentence to the box (and takes it out again). */
const SUGGESTIONS: { label: string; text: string; aspect?: '9:16' }[] = [
  { label: 'Cut pauses and filler words', text: 'Cut the pauses, ums and false starts.' },
  { label: 'Add captions', text: 'Add bold captions of what I say.' },
  { label: 'Make a 30s highlight', text: 'Make a 30-second highlight of the best moments.' },
  { label: 'Add my logo and an end card', text: 'Add my logo and finish on a brand end card.' },
  { label: 'Vertical 9:16', text: 'Make it vertical for Reels and Shorts.', aspect: '9:16' },
];

const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function Clip({ c, onRemove }: { c: RawClip; onRemove: () => void }) {
  const state = c.error ? c.error : c.key ? 'Uploaded' : `Uploading ${Math.round(c.progress * 100)}%`;
  return (
    <li className={`footage-clip${c.error ? ' is-error' : ''}`}>
      <Icon name={c.error ? 'alert' : 'play'} size={14} aria-hidden="true" />
      <div className="footage-clip-body">
        <span className="footage-clip-name">{c.name}</span>
        <span className="compose-note tnum">{[mb(c.size), c.sec != null ? mmss(c.sec) : null].filter(Boolean).join(' · ')} · <span role="status">{state}</span></span>
        {!c.key && !c.error && (
          <div className="footage-bar" aria-hidden="true"><i style={{ transform: `scaleX(${c.progress})` }} /></div>
        )}
      </div>
      <button type="button" className="icon-btn" aria-label={`Remove ${c.name}`} onClick={onRemove}><Icon name="x" size={12} /></button>
    </li>
  );
}

/** "Edit my video": raw clips in, the user's ask, shape/length/sound, one button with its quote. */
export function FootageOptions({ gen }: { gen: MediaGen }) {
  const { s, set, clips } = gen;
  const file = useRef<HTMLInputElement | null>(null);
  const { data: credits } = useApi<{ balance: number }>('/api/credits');

  const known = clips.every((c) => c.sec != null);
  const sourceSec = known ? clips.reduce((n, c) => n + (c.sec ?? 0), 0) : null;
  const cap = footageEditCap(s.footageLength, sourceSec);
  const price = priceForFootageEdit(cap, { music: s.footageMusic });
  const uploading = clips.some((c) => !c.key && !c.error);
  const reason = !clips.length ? 'Add at least one clip.'
    : uploading ? 'Wait for the clips to finish uploading.'
    : clips.some((c) => c.error) ? 'Remove the clip that didn’t upload.'
    : credits && credits.balance < price.credits ? `Needs ${price.credits} cr — you have ${credits.balance}.`
    : null;
  const ask = s.footageAsk;
  const toggle = (t: (typeof SUGGESTIONS)[number]) => {
    const on = ask.includes(t.text);
    set({ footageAsk: on ? ask.replace(t.text, '').replace(/\s{2,}/g, ' ').trim() : `${ask.trim()} ${t.text}`.trim(), ...(!on && t.aspect ? { videoAspect: t.aspect } : {}) });
  };
  const extra = motionAiExtraMin(cap) + Math.ceil((sourceSec ?? 60) / 60);

  return (
    <div className="compose-media-panel">
      <input
        ref={file} type="file" hidden multiple accept={[...FOOTAGE_EDIT.mimes, '.mov', '.mp4', '.webm', '.m4v'].join(',')}
        onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) void gen.addClips(fs); }}
      />
      <div className="compose-field">
        <span className="compose-label">Your clips</span>
        <span className="compose-note">Up to {FOOTAGE_EDIT.maxClips}, 1 GB and 10 minutes each. They play in this order.</span>
        {clips.length > 0 && (
          <ul className="footage-clips">
            {clips.map((c) => <Clip key={c.id} c={c} onRemove={() => gen.removeClip(c.id)} />)}
          </ul>
        )}
        <div className="row compose-wrap">
          <Button size="sm" onClick={() => file.current?.click()} disabled={clips.length >= FOOTAGE_EDIT.maxClips} reason={`${FOOTAGE_EDIT.maxClips} clips is the most.`}>
            <Icon name="upload" size={12} /> {clips.length ? 'Add more clips' : 'Add clips'}
          </Button>
        </div>
      </div>

      <div className="compose-field">
        <label className="compose-label" htmlFor="footage-ask">How should we edit it?</label>
        <textarea
          id="footage-ask" className="input" rows={3} maxLength={2000} value={ask}
          placeholder="e.g. Cut the ums, add bold captions, zoom in on the product, end on my logo."
          onChange={(e) => set({ footageAsk: e.target.value })}
        />
        <div className="compose-chips" role="group" aria-label="Suggestions">
          {SUGGESTIONS.map((t) => (
            <button key={t.label} type="button" className="chip" aria-pressed={ask.includes(t.text)} onClick={() => toggle(t)}>{t.label}</button>
          ))}
        </div>
        {!ask.trim() && <p className="compose-note">Left empty, we cut the pauses and filler and keep your best takes.</p>}
      </div>

      <div className="compose-grid">
        <label className="compose-field">
          <span className="compose-label">Shape</span>
          <select className="input" value={s.videoAspect} onChange={(e) => set({ videoAspect: e.target.value as typeof s.videoAspect })}>
            <option value="9:16">Vertical 9:16</option>
            <option value="1:1">Square 1:1</option>
            <option value="16:9">Wide 16:9</option>
          </select>
        </label>
      </div>

      <div className="compose-field" role="group" aria-label="Sound">
        <span className="compose-label">Sound</span>
        <span className="compose-note">Your own audio is always kept.</span>
        <label className="compose-check">
          <input type="checkbox" checked={s.footageMusic} onChange={(e) => set({ footageMusic: e.target.checked })} />
          Music bed under your voice <span className="compose-note">+4 cr/s</span>
        </label>
        <label className="compose-check">
          <input type="checkbox" checked={s.footageSfx} onChange={(e) => set({ footageSfx: e.target.checked })} />
          Sound effects on graphics <span className="compose-note">free</span>
        </label>
      </div>

      <p className="compose-note">
        {s.footageLength == null ? `Up to ${cap}s, the length the edit needs` : `About ${cap}s`} · {price.perSec} cr per second of the finished video, charged up to {price.credits} cr now — unused seconds come back.
        {' '}Takes {8 + Math.round(extra / 2)}–{20 + extra} minutes.
      </p>
      <div className="row compose-wrap">
        <Button variant="primary" cost={price.credits} busy={gen.busy === 'video'} disabled={Boolean(reason) || gen.busy !== null} reason={reason ?? undefined} onClick={() => void gen.generateFootage()}>
          <Icon name="sparkle" size={12} /> {gen.busy === 'video' ? 'Editing…' : 'Edit my video'}
        </Button>
      </div>
    </div>
  );
}
