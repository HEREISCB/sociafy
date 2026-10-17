'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { priceForMotionAiEdit } from '../../lib/credits/pricing';
import type { MotionAudio, MotionSegment } from '../../lib/ai/motionAi';
import { pollJob, RenderStatus, type Render } from './generate';
import type { MediaItem } from './attachments';

type Version = { jobId: string; version: number; status: string; instruction: string | null; assetId: string | null; videoUrl: string | null; posterUrl: string | null };
export type MotionEditData = {
  jobId: string;
  version: number;
  durationSec: number;
  aspect: string;
  videoUrl: string;
  posterUrl: string | null;
  segments: MotionSegment[];
  /** What this version's MP4 carries; null = silent. */
  audio?: MotionAudio | null;
  versions: Version[];
};

/** Quick asks for the audio this version actually has. */
function audioChips(a: MotionAudio | null | undefined): string[] {
  if (!a) return [];
  return [
    a.narration ? 'Make the voice calmer' : null,
    a.sfx ? 'Remove the sound effects' : null,
    a.music ? 'Lower the music' : null,
  ].filter((x): x is string => x !== null);
}

const EDITING: Omit<Render, 'startedAt'> = { phases: ['rendering'], usual: 'Editing — usually 1–5 minutes.', slowAfterSec: 6 * 60 };

/**
 * "Edit like you'd ask an editor": play the motion graphic, pick a segment on
 * its timeline (or the whole video), say what should change. Each edit is a
 * new version (v1, v2, …) and a new library item; "Use this version" swaps it
 * into the post. `id` is the media asset (or job) id of the version opened.
 */
export function MotionEditor({
  id, onUse, onClose, onCredits, onCharged,
}: {
  id: string;
  onUse: (item: MediaItem) => void;
  onClose: () => void;
  onCredits: (e: { balance: number; needed: number }) => void;
  onCharged: () => void;
}) {
  const [data, setData] = useState<MotionEditData | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [render, setRender] = useState<Render | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const alive = useRef(true);
  const following = useRef<string | null>(null);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (jobId: string) => {
    try {
      const r = await fetch(`/api/media/motion-ai/${jobId}/segments`, { credentials: 'include' });
      if (!alive.current) return null;
      if (!r.ok) { setNotice(r.status === 404 ? 'This video can’t be edited.' : 'Could not load the editor. Try again.'); return null; }
      const d = (await r.json()) as MotionEditData;
      setData(d);
      setSel(null);
      return d;
    } catch {
      if (alive.current) setNotice('Could not load the editor. Check your connection.');
      return null;
    }
  }, []);

  const follow = useCallback(async (jobId: string) => {
    if (following.current) return;
    following.current = jobId;
    setRender({ startedAt: Date.now(), ...EDITING });
    const out = await pollJob(`/api/media/video-job/${jobId}`, 15 * 60_000, [4_000, 500, 8_000]);
    following.current = null;
    if (!alive.current) return;
    setRender(null);
    if ('asset' in out && out.asset) { setText(''); await load(jobId); return; }
    setNotice(out.failed === 'poll_timeout'
      ? 'Still editing — the new version will land in your library.'
      : 'That edit could not be made. Your credits were returned — try wording it differently.');
  }, [load]);

  useEffect(() => {
    void load(id).then((d) => {
      const pending = d?.versions.find((v) => v.status === 'pending');
      if (pending) void follow(pending.jobId); // an edit still rendering from before
    });
  }, [id, load, follow]);

  const apply = async () => {
    if (!data || !text.trim() || render) return;
    setNotice(null);
    try {
      const r = await fetch(`/api/media/motion-ai/${data.jobId}/edit`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: text.trim(), ...(sel ? { segmentId: sel } : {}) }),
      });
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.status === 402 && body.error === 'insufficient_credits') { onCredits({ balance: Number(body.balance ?? 0), needed: Number(body.needed ?? 0) }); return; }
      const jobId = (body.job as { id?: string } | undefined)?.id;
      if (r.status !== 202 || !jobId) {
        setNotice(typeof body.hint === 'string' ? body.hint : r.status === 429 ? 'Too many requests — wait a minute and try again.' : 'The edit did not start. Try again.');
        return;
      }
      onCharged();
      void follow(jobId);
    } catch {
      setNotice('The edit did not start. Check your connection and try again.');
    }
  };

  const pick = (s: MotionSegment | null) => {
    setSel(s?.id ?? null);
    if (s && video.current) video.current.currentTime = s.startSec;
  };

  const cur = data?.versions.find((v) => v.jobId === data.jobId);
  const seg = data?.segments.find((s) => s.id === sel) ?? null;
  const suggestions = [...new Set([
    ...(seg ? seg.suggestions : (data?.segments ?? []).flatMap((s) => s.suggestions.slice(0, 1)).slice(0, 4)),
    ...audioChips(data?.audio),
  ])];
  const cost = data ? priceForMotionAiEdit(data.durationSec).credits : 0;
  const dur = data?.durationSec || 1;

  return (
    <div className="modal-scrim" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="modal-sheet motion-edit" role="dialog" aria-modal="true" aria-labelledby="motion-edit-head" onClick={(e) => e.stopPropagation()}>
        <div className="row motion-edit-head">
          <h3 id="motion-edit-head">Edit video</h3>
          {data && data.versions.length > 1 && (
            <div className="compose-chips" role="group" aria-label="Versions">
              {data.versions.map((v) => (
                <button
                  key={v.jobId} type="button"
                  className={`prompt-chip${v.jobId === data.jobId ? ' active' : ''}`}
                  aria-pressed={v.jobId === data.jobId}
                  disabled={v.status !== 'completed' || Boolean(render)}
                  title={v.instruction ?? 'Original'}
                  onClick={() => { if (v.jobId !== data.jobId) void load(v.jobId); }}
                >
                  v{v.version}{v.status === 'pending' ? ' · editing' : ''}
                </button>
              ))}
            </div>
          )}
        </div>

        {!data && !notice && <p className="compose-note">Loading…</p>}
        {data && (
          <>
            <video
              key={data.videoUrl}
              ref={video}
              className="motion-edit-player"
              src={data.videoUrl}
              poster={data.posterUrl ?? undefined}
              style={{ aspectRatio: data.aspect.replace(':', '/') }}
              controls playsInline preload="metadata"
            />

            {data.segments.length > 0 ? (
              <div className="motion-edit-parts">
                <button type="button" className={`prompt-chip${sel === null ? ' active' : ''}`} aria-pressed={sel === null} onClick={() => pick(null)}>
                  Whole video
                </button>
                <div className="motion-edit-timeline" role="group" aria-label="Parts of the video">
                  {data.segments.map((s) => (
                    <button
                      key={s.id} type="button"
                      className="motion-edit-seg" aria-pressed={sel === s.id}
                      title={`${s.label} · ${s.startSec.toFixed(1)}–${s.endSec.toFixed(1)}s${s.onScreenText ? ` · “${s.onScreenText}”` : ''}`}
                      style={{ left: `${(s.startSec / dur) * 100}%`, width: `${((s.endSec - s.startSec) / dur) * 100}%` }}
                      onClick={() => pick(s)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="compose-note">Describe the change for the whole video.</p>
            )}

            {seg?.narration && <p className="compose-note motion-edit-narration">Voiceover: “{seg.narration}”</p>}

            {suggestions.length > 0 && (
              <div className="compose-chips" role="group" aria-label="Suggestions">
                {suggestions.map((t) => (
                  <button key={t} type="button" className="prompt-chip" onClick={() => setText(t)} disabled={Boolean(render)}>{t}</button>
                ))}
              </div>
            )}

            <label className="compose-field">
              <span className="compose-label">What should change?{seg ? ` — ${seg.label}` : ''}</span>
              <textarea
                className="motion-edit-text"
                value={text}
                maxLength={1_000}
                rows={3}
                disabled={Boolean(render)}
                placeholder="e.g. Make the headline bigger and hold it a beat longer"
                onChange={(e) => setText(e.target.value)}
              />
            </label>

            {render && <RenderStatus render={render} />}
          </>
        )}
        {notice && <p className="compose-note compose-error" role="alert">{notice}</p>}

        <div className="row compose-crop-actions">
          <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>
          {data && cur?.assetId && (
            <button
              type="button" className="btn sm" disabled={Boolean(render)}
              onClick={() => onUse({ id: cur.assetId!, url: data.videoUrl, mimeType: 'video/mp4', label: `Motion graphic v${data.version}`, aspect: data.aspect.replace(':', '/'), motionAi: true })}
            >
              Use this version
            </button>
          )}
          <button type="button" className="btn primary sm" disabled={!data || !text.trim() || Boolean(render)} onClick={apply}>
            {render ? 'Editing…' : 'Apply edit'} <span className="compose-cost">· {cost} cr</span>
          </button>
        </div>
      </div>
    </div>
  );
}
