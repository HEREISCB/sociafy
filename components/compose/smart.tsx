'use client';

import React, { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { useApi } from '../../lib/ui/fetcher';
import type { CreditsPayload } from '../credits';
import type { MediaGen, PlanResponse, VideoFormat } from './generate';

const FORMAT: Record<VideoFormat, string> = {
  motion_graphic: 'Motion graphic',
  ai_video: 'AI video',
  hybrid: 'AI footage + motion graphic',
  none: 'No video',
};
const SHAPE: Record<string, string> = { '9:16': 'Vertical', '1:1': 'Square', '16:9': 'Wide' };
const MIN_CHARS = 15;

/** Video tab default: the planner picks the format, length and sound; one button renders it. */
export function SmartVideo({ gen, text, platforms, attachments }: {
  gen: MediaGen;
  text: string;
  platforms: string[];
  attachments: { url: string; mimeType: string }[];
}) {
  const [res, setRes] = useState<PlanResponse | null>(null);
  const [plannedKey, setPlannedKey] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState<VideoFormat | null>(null);
  /** The price rose at submit; the user has to confirm the new one. */
  const [repriced, setRepriced] = useState(false);
  const [retry, setRetry] = useState(0);
  const { data: credits } = useApi<CreditsPayload>('/api/credits');

  const tooShort = text.trim().length < MIN_CHARS;
  const key = JSON.stringify([text.trim(), platforms, attachments.map((a) => a.url), override]);

  useEffect(() => {
    if (tooShort) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setPlanning(true);
      setError(null);
      try {
        const r = await fetch('/api/media/plan-video', {
          method: 'POST', credentials: 'include', signal: ctrl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text.trim(), platforms, attachments, ...(override ? { overrides: { format: override } } : {}) }),
        });
        const data = (await r.json().catch(() => ({}))) as PlanResponse & { hint?: string };
        if (!r.ok || !data.plan) {
          setError(typeof data.hint === 'string' ? data.hint : r.status === 401 ? 'Your session expired — sign in again.' : 'Couldn’t plan this video. Try again.');
          return;
        }
        setRes(data);
        setPlannedKey(key);
        setRepriced(false);
      } catch {
        if (!ctrl.signal.aborted) setError('Couldn’t plan this video. Check your connection and try again.');
      } finally {
        if (!ctrl.signal.aborted) setPlanning(false);
      }
    }, 800);
    return () => { clearTimeout(t); ctrl.abort(); };
    // `key` covers text, platforms, attachments and override.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry, tooShort]);

  const chooseMyself = (
    <button type="button" className="btn ghost sm compose-self-start" onClick={() => gen.set({ videoSmart: false })}>Choose myself</button>
  );

  if (tooShort) {
    return (
      <div className="compose-media-panel">
        {text.trim() && <p className="compose-note">Write a little more and we’ll pick the best kind of video for it.</p>}
        {chooseMyself}
      </div>
    );
  }

  const stale = key !== plannedKey;
  if (error && !planning) {
    return (
      <div className="compose-media-panel">
        <p className="compose-note compose-error">{error}</p>
        <div className="row">
          <button type="button" className="btn sm" onClick={() => setRetry((n) => n + 1)}><Icon name="refresh" size={12} /> Try again</button>
          {chooseMyself}
        </div>
      </div>
    );
  }
  if (!res) {
    return (
      <div className="compose-media-panel" aria-busy="true">
        <span className="sr-only" role="status">Planning your video…</span>
        <div className="sk smart-sk smart-sk--title" />
        <div className="sk smart-sk" />
        <div className="sk smart-sk smart-sk--short" />
        {chooseMyself}
      </div>
    );
  }

  const { plan, summary, estimatedCredits: price } = res;
  const reasons = (res.reasons?.length ? res.reasons : plan.reasons ?? []).slice(0, 3);
  const balance = credits?.balance ?? res.balance;
  const short = balance != null && balance < price;
  const none = plan.format === 'none';
  const busy = gen.busy === 'video';
  const updating = stale || planning;
  const sound = [
    plan.audio?.narration && { icon: 'mic' as const, label: 'Voiceover' },
    plan.audio?.music && { icon: 'waveform' as const, label: 'Music' },
    plan.audio?.sfx && { icon: 'bolt' as const, label: 'Sound effects' },
  ].filter((x): x is { icon: 'mic' | 'waveform' | 'bolt'; label: string } => Boolean(x));

  const go = async () => {
    const fresh = await gen.generateAuto({ text: text.trim(), plan, platforms, attachments });
    if (fresh) {
      setRes((cur) => ({ ...cur, ...fresh, reasons: fresh.reasons ?? fresh.plan.reasons ?? cur?.reasons }));
      setRepriced(true);
    }
  };

  return (
    <div className={`compose-media-panel smart-card${updating ? ' is-updating' : ''}`} aria-busy={updating}>
      <div className="smart-head">
        <span className="compose-label">Best fit for this post</span>
        <h3 className="smart-format">{FORMAT[plan.format] ?? 'Video'}</h3>
        {summary && <p className="smart-summary">{summary}</p>}
      </div>
      {reasons.length > 0 && (
        <ul className="smart-reasons">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      {!none && (
        <div className="smart-meta">
          <span>{plan.durationSec}s</span>
          <span>{SHAPE[plan.aspect] ?? plan.aspect} {plan.aspect}</span>
          {sound.length ? sound.map((x) => (
            <span key={x.label} className="smart-sound"><Icon name={x.icon} size={12} aria-hidden="true" /> {x.label}</span>
          )) : <span>Silent</span>}
        </div>
      )}
      {(res.alternatives?.length || override) && !busy ? (
        <div className="compose-chips" role="group" aria-label="Other options">
          {res.alternatives?.map((a) => (
            <button key={a.format} type="button" className="prompt-chip" title={a.summary} disabled={updating} onClick={() => setOverride(a.format)}>
              {a.estimatedCredits < price ? 'Cheaper: ' : ''}{FORMAT[a.format] ?? a.format} · {a.estimatedCredits} cr
            </button>
          ))}
          {override && <button type="button" className="btn ghost sm" disabled={updating} onClick={() => setOverride(null)}>Back to the best fit</button>}
        </div>
      ) : null}

      {repriced && !updating && (
        <p className="compose-note compose-error" id="smart-reason">The price changed to {price} cr since we planned this. Nothing was charged — confirm to go ahead.</p>
      )}
      {short && !none && (
        <p className="compose-note compose-error" id="smart-reason">Not enough credits — {balance} of {price}.</p>
      )}
      <div className="row smart-actions">
        {!none && (
          <button
            type="button" className="btn primary" aria-describedby={short || repriced ? 'smart-reason' : undefined}
            disabled={busy || updating || short || gen.busy !== null} onClick={go}
          >
            <Icon name="sparkle" size={12} /> {busy ? 'Making video…' : updating ? 'Updating plan…' : repriced ? 'Confirm' : 'Generate'}
            <span className="compose-cost">{price} cr</span>
          </button>
        )}
        {chooseMyself}
      </div>
    </div>
  );
}
