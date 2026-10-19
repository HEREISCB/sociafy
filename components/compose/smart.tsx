'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon } from '../icons';
import { useApi } from '../../lib/ui/fetcher';
import { planKeys, shownPlan, type Keyed } from '../../lib/ui/planKey';
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

type Override = { format: Exclude<VideoFormat, 'none'> } | { cheapest: true };
// Keyed by planKeys().full (post + override), same as every request and response.
// ponytail: module-level memo of recent plans, so "Choose myself" → back (or re-picking a chip) is instant; per tab, no persistence.
const PLAN_TTL_MS = 5 * 60_000;
const plans = new Map<string, { at: number; res: PlanResponse }>();
const recall = (key: string) => {
  const hit = plans.get(key);
  return hit && Date.now() - hit.at < PLAN_TTL_MS ? hit.res : null;
};
const remember = (key: string, res: PlanResponse) => {
  plans.delete(key);
  plans.set(key, { at: Date.now(), res });
  if (plans.size > 30) plans.delete(plans.keys().next().value!);
};

/** Video tab default: the planner picks the format, length and sound; one button renders it. */
export function SmartVideo({ gen, text, platforms, attachments, length, setLength }: {
  gen: MediaGen;
  text: string;
  platforms: string[];
  attachments: { url: string; mimeType: string }[];
  /** Picked length in seconds (null = Auto). Held by Compose so its chat can set it. */
  length: number | null;
  setLength: (n: number | null) => void;
}) {
  // An override belongs to the post it was picked on: new text, platforms or attachments → best fit again.
  const [picked, setPicked] = useState<{ input: string; v: Override } | null>(null);
  const inputKey = planKeys(text, platforms, attachments, null).input;
  const pickedFormat = picked?.input === inputKey ? picked.v : null;
  // The chosen length rides along with any format pick; it sticks across posts until set back to Auto.
  const override = pickedFormat || length ? { ...pickedFormat, ...(length ? { durationSec: length } : {}) } : null;
  const keys = planKeys(text, platforms, attachments, override);
  const key = keys.full;
  const setOverride = (v: Override | null) => setPicked(v && { input: keys.input, v });
  /** The last plan that arrived, with the exact inputs (and override) it was planned for. */
  const [last, setLast] = useState<(Keyed<PlanResponse> & { override: typeof override }) | null>(null);
  // Exactly these inputs (cache or response), else this post's last plan while re-planning; never another post's.
  const shown = shownPlan(keys, recall(key), last);
  const res = shown.res;
  const [planningKey, setPlanningKey] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; msg: string } | null>(null);
  /** The price rose at submit; the user has to confirm the new one. */
  const [repricedKey, setRepricedKey] = useState<string | null>(null);
  const repriced = repricedKey === key;
  const [retry, setRetry] = useState(0);
  const { data: credits } = useApi<CreditsPayload>('/api/credits');
  const live = useRef(key);
  useEffect(() => { live.current = key; }, [key]);

  const tooShort = text.trim().length < MIN_CHARS;

  useEffect(() => {
    if (tooShort || recall(key)) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setPlanningKey(key);
      setError(null);
      try {
        const r = await fetch('/api/media/plan-video', {
          method: 'POST', credentials: 'include', signal: ctrl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text.trim(), platforms, attachments, ...(override ? { overrides: override } : {}) }),
        });
        const data = (await r.json().catch(() => ({}))) as PlanResponse & { hint?: string };
        // A response for inputs that are no longer on screen is dropped, aborted or not.
        if (ctrl.signal.aborted || live.current !== key) return;
        if (!r.ok || !data.plan) {
          setError({ key, msg: typeof data.hint === 'string' ? data.hint : r.status === 401 ? 'Your session expired — sign in again.' : 'Couldn’t plan this video. Try again.' });
          return;
        }
        remember(key, data);
        setLast({ key, input: keys.input, res: data, override });
        setRepricedKey(null);
      } catch {
        if (!ctrl.signal.aborted && live.current === key) setError({ key, msg: 'Couldn’t plan this video. Check your connection and try again.' });
      } finally {
        setPlanningKey((k) => (k === key ? null : k));
      }
    }, 500);
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

  const err = error?.key === key && planningKey !== key ? error.msg : null;
  if (err && !shown.current) {
    return (
      <div className="compose-media-panel">
        <p className="compose-note compose-error">{err}</p>
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
        <p className="compose-note" role="status">Picking the best format…</p>
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
  const short = (balance != null && balance < price) || res.affordable === false;
  // The server dedupes options (cheapest ≠ plan ≠ alternatives); show cheapest only when it is cheaper.
  const cheapest = short && res.cheapest && res.cheapest.estimatedCredits < price ? res.cheapest : null;
  const none = plan.format === 'none';
  const busy = gen.busy === 'video';
  const updating = !shown.current;
  // The label describes the plan on screen: while a re-plan is in flight that's still the last one.
  const shownOverride = updating ? last?.override : override;
  const formatPicked = shownOverride && ('format' in shownOverride || 'cheapest' in shownOverride);
  const sound = [
    plan.audio?.narration && { icon: 'mic' as const, label: 'Voiceover' },
    plan.audio?.music && { icon: 'waveform' as const, label: 'Music' },
    plan.audio?.sfx && { icon: 'bolt' as const, label: 'Sound effects' },
  ].filter((x): x is { icon: 'mic' | 'waveform' | 'bolt'; label: string } => Boolean(x));

  const go = async () => {
    const fresh = await gen.generateAuto({ text: text.trim(), plan, platforms, attachments });
    if (fresh) {
      // Summary and reasons always come from the fresh plan, never the old card.
      const next = { ...res, ...fresh, summary: fresh.summary ?? fresh.plan.summary ?? '', reasons: fresh.reasons ?? fresh.plan.reasons ?? [] };
      remember(key, next);
      setLast({ key, input: keys.input, res: next, override });
      setRepricedKey(key);
    }
  };

  return (
    <div className={`compose-media-panel smart-card${updating ? ' is-updating' : ''}`} aria-busy={updating}>
      <div className="smart-head">
        <span className="compose-label">{formatPicked ? 'Your pick' : 'Best fit for this post'}</span>
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
      {(res.alternatives?.length || pickedFormat || cheapest) && !busy ? (
        <div className="compose-chips" role="group" aria-label="Other options">
          {cheapest && (
            <button type="button" className="prompt-chip" title={cheapest.summary} disabled={updating} onClick={() => setOverride({ cheapest: true })}>
              Cheapest: {cheapest.label ?? FORMAT[cheapest.format]} · {cheapest.estimatedCredits} cr
            </button>
          )}
          {res.alternatives?.slice(0, cheapest ? 2 : 3).map((a) => (
            <button key={a.key ?? a.format} type="button" className="prompt-chip" title={a.summary} disabled={updating || a.format === 'none'} onClick={() => a.format !== 'none' && setOverride({ format: a.format })}>
              {a.label ?? FORMAT[a.format]} · {a.estimatedCredits} cr
            </button>
          ))}
          {pickedFormat && <button type="button" className="btn ghost sm" disabled={updating} onClick={() => setOverride(null)}>Back to the best fit</button>}
        </div>
      ) : null}

      {repriced && !updating && (
        <p className="compose-note compose-error" id="smart-reason">The price changed to {price} cr since we planned this. Nothing was charged — confirm to go ahead.</p>
      )}
      {short && !none && (
        <p className="compose-note compose-error" id="smart-reason">
          Not enough credits — {balance ?? 0} of {price}. <Link href="/account/billing">Top up</Link>
        </p>
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
