'use client';

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from './icons';
import { apiDelete, apiPatch, apiPost, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';

type QuickMode = 'text' | 'image' | 'video';
type QuickSlot = { day: number; hour: number };
type CalView = 'week' | 'month' | 'list';

const HOURS = ['7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM'];

type ScheduledRow = {
  id: string;
  platform: Platform;
  scheduledAt: string;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';
  text: string;
  platformPostUrl?: string | null;
};

type CalEventType = 'posted' | 'scheduled' | 'ai' | 'draft' | 'failed' | 'canceled';
type CalEvent = {
  id: string;
  day: number;
  start: number;
  span: number;
  type: CalEventType;
  plats: string[];
  title: string;
  time: string;
};

/**
 * Ticking "now" as epoch ms, `0` until mounted.
 *
 * Every past/future decision in this file needs the current time, but reading
 * `Date.now()` in a render body is impure — the same render can produce
 * different output on the server and on the client, and near midnight it can
 * flip a `disabled` attribute between paints. The `0` sentinel means "not
 * mounted yet": callers treat it as "assume nothing is past", which is what
 * makes the server's first paint and the client's first paint agree.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Quick-compose modal — prompt → variants → schedule, without leaving the
 * calendar. Shared by the week grid (which pins the time to the clicked slot)
 * and the month grid (which has no hour, so it exposes a time picker).
 *
 * Owns its own draft state and clears it on close, so reopening on a different
 * day never inherits the previous slot's prompt or variants.
 */
interface QuickComposeModalProps {
  /** Target publish time, ISO. Controlled by the parent. */
  whenIso: string;
  /** When set, the modal renders a datetime input and reports edits upward.
   *  Month cells have no hour of their own, so they need this. */
  onWhenChange?: (iso: string) => void;
  onClose: () => void;
  /** Called after a successful schedule so the parent can revalidate. */
  onScheduled: () => void | Promise<unknown>;
}

const QuickComposeModal: React.FC<QuickComposeModalProps> = ({ whenIso, onWhenChange, onClose, onScheduled }) => {
  const accountsApi = useApi<{ platform: Platform }[]>('/api/accounts');
  const [mode, setMode] = useState<QuickMode>('text');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [variants, setVariants] = useState<null | Array<{ label: string; text: string; score?: number; rationale?: string }>>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [perPlatform, setPerPlatform] = useState<Partial<Record<Platform, string>>>({});
  /** Latched once /api/schedule has succeeded. Nothing on that POST path is
   *  idempotent — a second submit buys a second draft, a second scheduled
   *  publish, and a second credit charge — so this is a one-way door. */
  const [done, setDone] = useState(false);

  // Platform pills default to whatever's connected, but the user can dial that
  // down for this one post. Derived rather than synced through an effect, so
  // accounts arriving late can't clobber a selection the user already made.
  const connected = useMemo(() => (accountsApi.data ?? []).map((a) => a.platform), [accountsApi.data]);
  const [platformOverride, setPlatformOverride] = useState<Platform[] | null>(null);
  const platforms = platformOverride ?? connected.slice(0, 4);

  const togglePlatform = (p: Platform) => {
    setPlatformOverride((cur) => {
      const base = cur ?? connected.slice(0, 4);
      return base.includes(p) ? base.filter((x) => x !== p) : [...base, p];
    });
  };

  const close = () => {
    if (busy) return;
    onClose();
  };

  const now = useNow(30_000);
  const isPast = now !== 0 && new Date(whenIso).getTime() <= now;

  const generate = async () => {
    if (!prompt.trim()) { setMsg('Add a prompt first.'); return; }
    if (platforms.length === 0) { setMsg('Pick at least one platform.'); return; }
    setBusy(true);
    setMsg('Generating variants…');
    try {
      const composed = await apiPost<{
        variants: { label: string; text: string; score?: number; rationale?: string }[];
        perPlatform: Partial<Record<Platform, string>>;
      }>('/api/compose/variants', {
        prompt,
        platforms,
        preset: mode === 'video' ? 'reel' : 'announcement',
      });
      if (!composed.variants?.length) {
        setMsg('No draft came back. Try a different prompt.');
        return;
      }
      setVariants(composed.variants);
      setPerPlatform(composed.perPlatform ?? {});
      setPicked(composed.variants[0].label);
      setMsg(null);
    } catch (e) {
      setMsg(friendlyApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const schedule = async () => {
    if (done) return;
    if (!variants || !picked) { setMsg('Generate and pick a variant first.'); return; }
    if (new Date(whenIso).getTime() <= Date.now()) {
      setMsg('That time has already passed. Pick a future time.');
      return;
    }
    const chosen = variants.find((v) => v.label === picked) ?? variants[0];
    setBusy(true);
    setMsg('Scheduling…');
    let skipped: string[];
    try {
      const draft = await apiPost<{ id: string }>('/api/drafts', {
        prompt,
        body: chosen.text,
        variants: variants.map((v) => ({ label: v.label, text: v.text, score: v.score, rationale: v.rationale })),
        selectedVariantLabel: chosen.label,
        targetPlatforms: platforms,
        perPlatformText: perPlatform,
        preset: mode === 'video' ? 'reel' : 'announcement',
      });
      const res = await apiPost<{ scheduled: unknown[]; skipped?: string[] }>(
        '/api/schedule',
        { draftId: draft.id, scheduledAt: whenIso, platforms },
      );
      skipped = res.skipped ?? [];
    } catch (e) {
      setMsg(friendlyApiError(e));
      setBusy(false);
      return;
    }
    // Committed. Everything below is bookkeeping and must never re-open the
    // submit path — the post is scheduled and the credit is spent whether or
    // not the parent's cache manages to catch up.
    setDone(true);
    setBusy(false);
    setMsg(skipped.length > 0 ? `Scheduled. Skipped ${skipped.join(', ')} — not connected.` : 'Scheduled.');
    try {
      await onScheduled();
    } catch {
      // Revalidation is the parent's SWR cache refreshing. If it rejects the
      // post is still scheduled, so this must not read as a failure — the list
      // picks it up on its next poll or remount.
    }
    setTimeout(onClose, skipped.length > 0 ? 2500 : 700);
  };

  return (
    <div className="modal-scrim" onClick={close}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 92vw)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Icon name="sparkle" size={16} style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: 15, letterSpacing: '-0.01em' }}>What do you want to post?</h3>
          {!onWhenChange && (
            <span className="chip ghost mono" style={{ marginLeft: 'auto' }}>
              {new Date(whenIso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
          <button className="icon-btn" style={onWhenChange ? { marginLeft: 'auto' } : undefined} onClick={close}>
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* Month cells carry no hour — let the user set one here. */}
        {onWhenChange && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              When
            </div>
            <input
              type="datetime-local"
              value={toLocalInputValue(whenIso)}
              onChange={(e) => {
                const d = new Date(e.target.value);
                if (!Number.isNaN(d.getTime())) onWhenChange(d.toISOString());
              }}
              style={{ padding: '8px 10px', border: `1px solid ${isPast ? 'var(--bad)' : 'var(--line-2)'}`, borderRadius: 8, fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--bg)', color: 'var(--ink)' }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {(['text', 'image', 'video'] as QuickMode[]).map((m) => (
            <span
              key={m}
              onClick={() => setMode(m)}
              className={`prompt-chip ${mode === m ? 'active' : ''}`}
              style={{ textTransform: 'capitalize' }}
            >
              <Icon name={m === 'text' ? 'edit' : m === 'image' ? 'image' : 'play'} size={11} />
              {m === 'text' ? 'Text' : m === 'image' ? 'Image' : 'Video'} post
            </span>
          ))}
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What's this post about? One sentence is enough."
          autoFocus
          style={{
            width: '100%', minHeight: 72, padding: 12, fontSize: 13,
            border: '1px solid var(--line-2)', borderRadius: 10, background: 'var(--bg)',
            color: 'var(--ink)', fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5,
            marginBottom: 10,
          }}
        />

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Platforms
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {connected.map((p) => {
              const on = platforms.includes(p);
              return (
                <span
                  key={p}
                  onClick={() => togglePlatform(p)}
                  className={`prompt-chip ${on ? 'active' : ''}`}
                  style={{ textTransform: 'capitalize' }}
                >
                  {p}
                </span>
              );
            })}
            {connected.length === 0 && (
              <span style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>
                No accounts connected yet.
              </span>
            )}
          </div>
        </div>

        {variants && variants.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              Pick a variant
              <button className="chip ghost" onClick={generate} disabled={busy} style={{ marginLeft: 'auto', fontSize: 10 }}>
                <Icon name="refresh" size={10} /> Regenerate
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
              {variants.map((v) => {
                const on = picked === v.label;
                return (
                  <div
                    key={v.label}
                    onClick={() => setPicked(v.label)}
                    style={{
                      padding: 10, fontSize: 12, lineHeight: 1.4,
                      border: on ? '2px solid var(--accent)' : '1px solid var(--line-2)',
                      borderRadius: 8, background: on ? 'var(--accent-soft)' : 'var(--bg)',
                      cursor: 'pointer', position: 'relative',
                      display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}
                  >
                    <div style={{ fontSize: 9.5, fontFamily: 'var(--mono)', color: on ? 'var(--accent-ink)' : 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                      {v.label}{typeof v.score === 'number' ? ` · ${Math.round(v.score)}` : ''}
                    </div>
                    {v.text}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {msg && (
          <div style={{ padding: 10, fontSize: 12.5, background: 'var(--bg-sunk)', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 12 }}>
            {msg}
          </div>
        )}

        {/* Lives outside the time-picker branch: `isPast` disables the Schedule
            button in BOTH modes, and the week-grid mode has no picker, so a
            message nested in that branch left its button dead and silent. */}
        {isPast && (
          <div style={{ padding: 10, fontSize: 12.5, color: 'var(--bad)', background: 'var(--bg-sunk)', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 12 }}>
            {onWhenChange
              ? 'That time is in the past — pick a later time to schedule.'
              : 'This slot is in the past — close this and pick a later slot.'}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <a
            href={`/dashboard?tab=compose&prompt=${encodeURIComponent(prompt)}&slot=${encodeURIComponent(whenIso)}&platforms=${encodeURIComponent(platforms.join(','))}`}
            className="chip ghost"
            style={{ fontSize: 11 }}
          >
            <Icon name="edit" size={10} /> Edit in compose
          </a>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={close} disabled={busy}>Cancel</button>
          {!variants ? (
            <button
              className="btn primary"
              onClick={generate}
              disabled={busy || !prompt.trim() || platforms.length === 0}
            >
              {busy ? <><Icon name="refresh" size={12} /> Generating</> : <><Icon name="sparkle" size={12} /> Generate variants</>}
            </button>
          ) : (
            <button className="btn primary" onClick={schedule} disabled={busy || done || !picked || isPast}>
              {busy ? <><Icon name="refresh" size={12} /> Scheduling</> : done ? <><Icon name="check" size={12} /> Scheduled</> : <><Icon name="calendar" size={12} /> Schedule this</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/** Label + dot color for each event type. failed/canceled are surfaced
 *  distinctly (var(--bad)) so a failed publish isn't mistaken for a draft. */
const TYPE_LABEL: Record<CalEventType, string> = {
  posted: 'Posted',
  scheduled: 'Scheduled',
  ai: 'Agent draft',
  draft: 'Draft',
  failed: 'Failed',
  canceled: 'Canceled',
};

/** Maps a schedule row status to a calendar event type. Keeps failed/canceled
 *  distinct instead of collapsing them into a generic 'draft'. */
function statusToType(status: ScheduledRow['status']): CalEventType {
  switch (status) {
    case 'published': return 'posted';
    case 'pending':
    case 'publishing': return 'scheduled';
    case 'failed': return 'failed';
    case 'canceled': return 'canceled';
    default: return 'draft';
  }
}

const platGlyphs: Record<string, string> = { ig: 'I', fb: 'f', x: 'X', li: 'in', tt: 'T', yt: 'Y' };

function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = (day + 6) % 7; // Monday-first
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function fmtRange(start: Date) {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const sM = start.toLocaleDateString(undefined, { month: 'short' });
  const eM = end.toLocaleDateString(undefined, { month: 'short' });
  if (sM === eM) return `${sM} ${start.getDate()} – ${end.getDate()}, ${start.getFullYear()}`;
  return `${sM} ${start.getDate()} – ${eM} ${end.getDate()}, ${start.getFullYear()}`;
}

/** Short timezone label for the calendar's leftmost header cell.
 *  IANA names like "Asia/Kolkata" are too long for the 64px column and end
 *  up looking like empty space; "GMT+5:30" / "IST" fit and read clearly. */
function shortTzLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date());
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (tz) return tz;
  } catch { /* fall through */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface CalendarPageProps {
  /** Optional handler for the "New post" button — when provided, the button
   *  hands off to the compose surface. Falls back to a /dashboard?tab=compose
   *  navigation when omitted so the calendar stays usable in isolation. */
  onCompose?: () => void;
}

const CalendarPage: React.FC<CalendarPageProps> = ({ onCompose }) => {
  const router = useRouter();
  const slotH = 48;
  // Week-grid is unusable below ~900px (7 columns + time gutter don't fit).
  // We subscribe to the viewport so flipping the phone orientation re-evaluates.
  // SSR snapshot is `false` so server output always matches first client paint.
  const isNarrow = useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(max-width: 900px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(max-width: 900px)').matches,
    () => false,
  );
  const [viewOverride, setViewOverride] = useState<CalView | null>(null);
  const view: CalView = viewOverride ?? (isNarrow ? 'list' : 'week');
  const setView = setViewOverride;
  const [cursor, setCursor] = useState(() => startOfWeek(new Date()));
  const weekStart = cursor;
  const weekEnd = new Date(cursor);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const today = new Date();
  const todayIdx = ((today.getDay() + 6) % 7);
  const nowOffset = (today.getHours() + today.getMinutes() / 60 - 7) * slotH;

  const days = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(cursor);
    d.setDate(d.getDate() + i);
    return { num: d.getDate(), name: d.toLocaleDateString(undefined, { weekday: 'short' }), today: i === todayIdx && sameWeek(today, cursor) };
  });

  const url = `/api/schedule?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}`;
  const { data, unauth, mutate } = useApi<ScheduledRow[]>(url);
  const [selected, setSelected] = useState<ScheduledRow | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  // Reschedule is an explicit confirm — we hold the edited datetime-local
  // value here and only PATCH when the user clicks Reschedule, so partial
  // typing never moves a post mid-keystroke.
  const [rescheduleVal, setRescheduleVal] = useState<string>('');

  /** The slot the user clicked to open quick-compose. The modal itself owns
   *  the prompt/variant state — we only track which slot it's anchored to. */
  const [quickSlot, setQuickSlot] = useState<QuickSlot | null>(null);

  const slotIsoFor = (slot: QuickSlot): string => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + slot.day);
    d.setHours(7 + slot.hour, 0, 0, 0);
    return d.toISOString();
  };

  // Once a minute is plenty for "is this slot still in the future" decisions.
  const now = useNow(60_000);

  /** True when the slot's start time is in the past — the API would reject
   *  with `scheduledAt_in_past`, and the user can't fix that from a modal.
   *  We block the click upstream. */
  const isSlotPast = (slot: QuickSlot): boolean => {
    if (now === 0) return false; // pre-mount: don't pre-grey slots, avoid hydration mismatch
    const d = new Date(weekStart);
    d.setDate(d.getDate() + slot.day);
    d.setHours(7 + slot.hour, 0, 0, 0);
    return d.getTime() <= now;
  };

  // Seed the reschedule input whenever a different post is selected.
  useEffect(() => {
    setRescheduleVal(selected ? toLocalInputValue(selected.scheduledAt) : '');
  }, [selected]);

  // In-app confirm (replaces native confirm()) — mirrors the .modal-sheet pattern.
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const cancelScheduled = async (id: string) => {
    setSavingId(id);
    try {
      await apiDelete(`/api/schedule/${id}`);
      await mutate();
      setSelected(null);
      setConfirmCancelId(null);
    } finally {
      setSavingId(null);
    }
  };

  const rescheduleScheduled = async (id: string, whenIso: string) => {
    setSavingId(id);
    try {
      await apiPatch(`/api/schedule/${id}`, { scheduledAt: whenIso });
      await mutate();
    } finally {
      setSavingId(null);
    }
  };

  const events: CalEvent[] = useMemo(() => {
    if (!data) return [];
    return data.map((s) => {
      const d = new Date(s.scheduledAt);
      const dayIdx = Math.floor((d.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
      const start = Math.max(0, Math.min(13, d.getHours() - 7));
      const type = statusToType(s.status);
      return {
        id: s.id,
        day: dayIdx,
        start,
        span: 1,
        type,
        plats: [PLATFORM_TO_SHORT[s.platform]],
        title: s.text.slice(0, 60),
        time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
      };
    }).filter((e) => e.day >= 0 && e.day < 7);
  }, [data, weekStart]);

  // Demo events ONLY for unauthenticated visitors landing on the page.
  // Signed-in users with an empty schedule see a clean empty state.
  const showDemo = unauth;
  const demoEvents: CalEvent[] = showDemo ? [
    { id: 'd1', day: Math.max(0, todayIdx - 1), start: 2, span: 1, type: 'posted', plats: ['x'], title: 'AI is eating SEO — but slowly', time: '9:15' },
    { id: 'd2', day: todayIdx, start: 5, span: 1, type: 'scheduled', plats: ['li'], title: 'Newsletter recap: indie growth', time: '12:00' },
    { id: 'd3', day: Math.min(6, todayIdx + 1), start: 7, span: 1, type: 'scheduled', plats: ['x', 'li'], title: 'How we ship features without standups', time: '14:00' },
  ] : [];

  const all = events.concat(demoEvents);
  const counts = {
    posted: all.filter((e) => e.type === 'posted').length,
    scheduled: all.filter((e) => e.type === 'scheduled').length,
    ai: all.filter((e) => e.type === 'ai').length,
    draft: all.filter((e) => e.type === 'draft').length,
    failed: all.filter((e) => e.type === 'failed' || e.type === 'canceled').length,
  };

  // On phones/tablets the 7-column week grid can't fit — render a fit-to-width
  // month grid instead. (Hooks above always run; this branch has none.)
  if (isNarrow) {
    return <CalendarMobileMonth />;
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button className="btn sm" onClick={() => { const c = new Date(cursor); c.setDate(c.getDate() - 7); setCursor(c); }}>
          <Icon name="chevron_left" size={12} />
        </button>
        <div className="mono" style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.01em', minWidth: 200 }}>
          {fmtRange(cursor)}
        </div>
        <button className="btn sm" onClick={() => { const c = new Date(cursor); c.setDate(c.getDate() + 7); setCursor(c); }}>
          <Icon name="chevron_right" size={12} />
        </button>
        <button className="btn sm" onClick={() => setCursor(startOfWeek(new Date()))}>Today</button>
        <div style={{ flex: 1 }} />
        <div className="mode-switch" style={{ padding: 2 }}>
          <span
            className={`opt ${view === 'week' ? 'active' : ''}`}
            style={{ fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}
            onClick={() => setView('week')}
          >
            Week
          </span>
          <span
            className={`opt ${view === 'month' ? 'active' : ''}`}
            style={{ fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}
            onClick={() => setView('month')}
          >
            Month
          </span>
          <span
            className={`opt ${view === 'list' ? 'active' : ''}`}
            style={{ fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}
            onClick={() => setView('list')}
          >
            List
          </span>
        </div>
        <button
          className="btn sm primary"
          onClick={() => {
            if (onCompose) onCompose();
            else router.push('/dashboard?tab=compose');
          }}
        >
          <Icon name="plus" size={11} /> New post
        </button>
      </div>

      {unauth && (
        <div style={{ padding: 12, background: 'rgba(124,77,255,0.05)', border: '1px solid rgba(124,77,255,0.2)', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>
          Demo calendar — <Link href="/sign-in?next=/dashboard" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>sign in</Link> to see your real schedule.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="chip"><span className="dot" style={{ background: 'oklch(0.42 0.16 155)' }} />Posted ({counts.posted})</span>
        <span className="chip"><span className="dot" style={{ background: 'var(--ink)' }} />Scheduled ({counts.scheduled})</span>
        <span className="chip accent"><span className="dot" />Agent draft ({counts.ai})</span>
        <span className="chip"><span className="dot" style={{ background: 'var(--ink-4)' }} />Drafts ({counts.draft})</span>
        {counts.failed > 0 && (
          <span className="chip"><span className="dot" style={{ background: 'var(--bad)' }} />Failed / canceled ({counts.failed})</span>
        )}
      </div>

      {view === 'month' ? (
        <CalendarMobileMonth />
      ) : view === 'list' ? (
        <CalendarListView events={all} weekStart={weekStart} data={data ?? null} onSelect={setSelected} />
      ) : (
      <div className="calendar">
        <div className="cal-head">
          <div
            className="cell mono"
            style={{ fontSize: 11, padding: '14px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}
            title={Intl.DateTimeFormat().resolvedOptions().timeZone}
          >
            {shortTzLabel()}
          </div>
          {days.map((d, i) => (
            <div key={i} className={`cell ${d.today ? 'today' : ''}`}>
              <div>{d.name}</div>
              <span className="day">{d.num}</span>
            </div>
          ))}
        </div>
        <div className="cal-grid">
          <div className="cal-hour-col">
            {HOURS.map((h) => <div key={h} className="cal-hour-cell">{h}</div>)}
          </div>
          {days.map((_, dayIdx) => (
            <div key={dayIdx} className="cal-day-col">
              {HOURS.map((_, hi) => {
                const past = isSlotPast({ day: dayIdx, hour: hi });
                // Signed-out visitors used to get inert, disabled slots — the
                // click did nothing and explained nothing. Route them to
                // sign-in instead; only genuinely-past slots stay unclickable.
                const clickable = !past;
                return (
                  <button
                    type="button"
                    key={hi}
                    className="cal-slot"
                    disabled={!clickable}
                    onClick={() => {
                      if (!clickable) return;
                      if (unauth) { router.push('/sign-in?next=/dashboard'); return; }
                      setQuickSlot({ day: dayIdx, hour: hi });
                    }}
                    style={{
                      cursor: clickable ? 'pointer' : 'default',
                      background: past ? 'repeating-linear-gradient(135deg, transparent 0 6px, var(--bg-sunk) 6px 7px)' : undefined,
                      opacity: past ? 0.55 : 1,
                    }}
                    aria-label={past ? 'Past time' : unauth ? 'Sign in to schedule a post' : 'Schedule a post in this slot'}
                    title={past ? 'Past time' : unauth ? 'Sign in to schedule a post' : 'Click to schedule a post'}
                  />
                );
              })}
              {all.filter((e) => e.day === dayIdx).map((e) => {
                const real = data?.find((s) => s.id === e.id) ?? null;
                const bad = e.type === 'failed' || e.type === 'canceled';
                return (
                  <button
                    type="button"
                    key={e.id}
                    className={`cal-event ${e.type}`}
                    disabled={!real}
                    style={{
                      top: e.start * slotH + 2,
                      height: e.span * slotH - 6,
                      cursor: real ? 'pointer' : 'default',
                      opacity: savingId === e.id ? 0.5 : 1,
                      ...(bad ? {
                        background: 'color-mix(in oklch, var(--bad) 10%, var(--bg-elev))',
                        borderColor: 'var(--bad)',
                        color: 'var(--bad)',
                        textDecoration: e.type === 'canceled' ? 'line-through' : undefined,
                      } : null),
                    }}
                    title={`${TYPE_LABEL[e.type]} · ${e.title}`}
                    onClick={() => real && setSelected(real)}
                  >
                    <div className="ev-time">{e.time} · {TYPE_LABEL[e.type]}</div>
                    <div className="ev-title">{e.title}</div>
                    <div style={{ display: 'flex', gap: 2, marginTop: 3 }}>
                      {e.plats.map((p) => (
                        <span key={p} className={`pglyph ${p}`} style={{ width: 12, height: 12, fontSize: 8, borderRadius: 3 }}>
                          {platGlyphs[p]}
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
              {dayIdx === todayIdx && sameWeek(today, weekStart) && <div className="cal-now" style={{ top: nowOffset }} />}
            </div>
          ))}
        </div>
      </div>
      )}

      {quickSlot && (
        <QuickComposeModal
          whenIso={slotIsoFor(quickSlot)}
          onClose={() => setQuickSlot(null)}
          onScheduled={mutate}
        />
      )}

      {selected && (
        <div
          className="modal-scrim"
          onClick={() => setSelected(null)}
        >
          <div
            className="modal-sheet"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(520px, 90vw)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span className={`pglyph ${PLATFORM_TO_SHORT[selected.platform]}`} style={{ width: 22, height: 22 }}>
                {platGlyphs[PLATFORM_TO_SHORT[selected.platform]]}
              </span>
              <h3 style={{ margin: 0, fontSize: 16, letterSpacing: '-0.01em' }}>
                {selected.platform} · {new Date(selected.scheduledAt).toLocaleString()}
              </h3>
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', padding: 14, background: 'var(--bg-sunk)', borderRadius: 10, marginBottom: 14, color: 'var(--ink-2)' }}>
              {selected.text}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>Reschedule</label>
              <input
                type="datetime-local"
                value={rescheduleVal}
                onChange={(e) => setRescheduleVal(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--line-2)', borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 12 }}
              />
              <button
                className="btn sm"
                disabled={
                  savingId === selected.id ||
                  !rescheduleVal ||
                  rescheduleVal === toLocalInputValue(selected.scheduledAt) ||
                  Number.isNaN(new Date(rescheduleVal).getTime())
                }
                onClick={() => {
                  const v = new Date(rescheduleVal);
                  if (!Number.isNaN(v.getTime())) rescheduleScheduled(selected.id, v.toISOString());
                }}
              >
                <Icon name="calendar" size={11} /> {savingId === selected.id ? 'Saving…' : 'Reschedule'}
              </button>
              <div style={{ flex: 1 }} />
              {selected.platformPostUrl && (
                <a className="btn sm ghost" href={selected.platformPostUrl} target="_blank" rel="noreferrer">
                  <Icon name="arrow_right" size={11} /> View
                </a>
              )}
              <button className="btn sm" onClick={() => setConfirmCancelId(selected.id)} disabled={savingId === selected.id}>
                <Icon name="x" size={11} /> Cancel post
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmCancelId && (
        <div className="modal-scrim" onClick={() => { if (!savingId) setConfirmCancelId(null); }}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ width: 'min(420px, 92vw)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 15, letterSpacing: '-0.01em' }}>Cancel this scheduled post?</h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
              It will not be published. This can&apos;t be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirmCancelId(null)} disabled={!!savingId}>Keep it</button>
              <button className="btn primary" onClick={() => cancelScheduled(confirmCancelId)} disabled={!!savingId}>
                {savingId ? 'Canceling…' : 'Cancel post'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

interface CalendarListViewProps {
  events: CalEvent[];
  weekStart: Date;
  data: ScheduledRow[] | null;
  onSelect: (row: ScheduledRow) => void;
}

const CalendarListView: React.FC<CalendarListViewProps> = ({ events, weekStart, data, onSelect }) => {
  const byDay = new Map<number, CalEvent[]>();
  for (const e of events) {
    const list = byDay.get(e.day) ?? [];
    list.push(e);
    byDay.set(e.day, list);
  }
  const days = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return { idx: i, date: d, label: d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) };
  });

  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {days.map((d) => {
          const list = (byDay.get(d.idx) ?? []).slice().sort((a, b) => a.start - b.start);
          return (
            <div key={d.idx} style={{ borderBottom: '1px solid var(--line)' }}>
              <div className="mono" style={{ padding: '10px 16px', fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'var(--bg-sunk)' }}>
                {d.label}
              </div>
              {list.length === 0 ? (
                <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--ink-4)' }}>Nothing scheduled.</div>
              ) : (
                list.map((e) => {
                  const real = data?.find((s) => s.id === e.id) ?? null;
                  const bad = e.type === 'failed' || e.type === 'canceled';
                  return (
                    <button
                      type="button"
                      key={e.id}
                      disabled={!real}
                      onClick={() => real && onSelect(real)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '64px 1fr auto',
                        gap: 12,
                        padding: '10px 16px',
                        width: '100%',
                        textAlign: 'left',
                        background: 'transparent',
                        cursor: real ? 'pointer' : 'default',
                        alignItems: 'center',
                        borderTop: '1px solid var(--line)',
                        borderLeft: 0, borderRight: 0, borderBottom: 0,
                      }}
                    >
                      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{e.time}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center' }}>
                          {e.plats.map((p) => (
                            <span key={p} className={`pglyph ${p}`} style={{ width: 14, height: 14, fontSize: 9, borderRadius: 3 }}>
                              {platGlyphs[p]}
                            </span>
                          ))}
                          <span className={`chip ${e.type === 'ai' ? 'accent' : ''}`} style={{ fontSize: 10, color: bad ? 'var(--bad)' : undefined }}>
                            {bad && <span className="dot" style={{ background: 'var(--bad)' }} />}
                            {TYPE_LABEL[e.type]}
                          </span>
                        </div>
                      </div>
                      {real && <Icon name="arrow_right" size={12} style={{ color: 'var(--ink-3)' }} />}
                    </button>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type MonthCellEvent = {
  row: ScheduledRow;
  type: CalEvent['type'];
  plats: string[];
  time: string;
  title: string;
};

const TYPE_DOT: Record<CalEventType, string> = {
  posted: 'oklch(0.42 0.16 155)',
  scheduled: 'var(--ink)',
  ai: 'var(--accent)',
  draft: 'var(--ink-4)',
  failed: 'var(--bad)',
  canceled: 'var(--bad)',
};

/**
 * Mobile calendar — a fit-to-width month grid of square day cells. Each day
 * shows colored dots for its posts; tapping a day reveals that day's posts
 * below. Self-contained (own month-range fetch + reschedule/cancel) so it
 * doesn't entangle with the week-scoped desktop grid above.
 */
const CalendarMobileMonth: React.FC = () => {
  const router = useRouter();
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [selectedDay, setSelectedDay] = useState<string>(() => ymd(new Date()));
  const [selected, setSelected] = useState<ScheduledRow | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rescheduleVal, setRescheduleVal] = useState<string>('');
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  /** Target time for quick-compose, or null when the modal is closed. A month
   *  cell carries no hour, so we seed one and let the modal's picker adjust. */
  const [createIso, setCreateIso] = useState<string | null>(null);
  const now = useNow(60_000);

  useEffect(() => {
    setRescheduleVal(selected ? toLocalInputValue(selected.scheduledAt) : '');
  }, [selected]);

  // 6-week grid: Monday on/before the 1st through the following 41 days.
  const gridStart = useMemo(() => startOfWeek(monthCursor), [monthCursor]);
  const gridEnd = useMemo(() => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + 42);
    return d;
  }, [gridStart]);

  const url = `/api/schedule?from=${gridStart.toISOString()}&to=${gridEnd.toISOString()}`;
  const { data, unauth, mutate } = useApi<ScheduledRow[]>(url);

  const byDate = useMemo(() => {
    const m = new Map<string, MonthCellEvent[]>();
    for (const s of data ?? []) {
      const d = new Date(s.scheduledAt);
      const key = ymd(d);
      const type = statusToType(s.status);
      const list = m.get(key) ?? [];
      list.push({
        row: s,
        type,
        plats: [PLATFORM_TO_SHORT[s.platform]],
        title: s.text.slice(0, 80),
        time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
      });
      m.set(key, list);
    }
    return m;
  }, [data]);

  const cells = useMemo(() => Array.from({ length: 42 }).map((_, i) => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    return d;
  }), [gridStart]);

  // Derived from the ticking clock, not a fresh Date() in the render body:
  // this feeds `disabled` on the "New post" control, and an impure read there
  // is a hydration-mismatch surface across midnight or a server/client TZ gap.
  // Empty until mounted — nothing is "today" and nothing is "past" yet.
  const todayKey = now === 0 ? '' : ymd(new Date(now));
  const monthLabel = monthCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const selectedEvents = (byDate.get(selectedDay) ?? []).slice().sort((a, b) => a.time.localeCompare(b.time));
  const selectedDate = useMemo(() => {
    const [y, mo, da] = selectedDay.split('-').map(Number);
    return new Date(y, mo - 1, da);
  }, [selectedDay]);

  const stepMonth = (dir: number) => {
    const d = new Date(monthCursor);
    d.setMonth(d.getMonth() + dir);
    setMonthCursor(d);
  };

  /** A day is creatable only if it hasn't fully passed — scheduling into the
   *  past is rejected by the API, so we don't offer it. Pre-mount (empty
   *  todayKey) nothing is greyed out, matching the week grid's isSlotPast. */
  const isPastDay = (dayKey: string) => todayKey !== '' && dayKey < todayKey;

  /**
   * Open quick-compose for a day. Month cells have no hour, so seed one: 9am
   * normally, or the next clear hour when 9am today has already gone by. Never
   * seed a past time — the API would reject it. The modal exposes a picker so
   * the user can move it anywhere within the day.
   */
  const openCreateFor = (dayKey: string) => {
    if (isPastDay(dayKey)) return;
    if (unauth) {
      router.push('/sign-in?next=/dashboard');
      return;
    }
    const [y, mo, da] = dayKey.split('-').map(Number);
    const when = new Date(y, mo - 1, da, 9, 0, 0, 0);
    if (when.getTime() <= now) {
      // Today, past 9am: round up to the next clear hour — but clamp inside the
      // day the user actually clicked. Unclamped, a 23:15 click rounds to 00:00
      // tomorrow while selectedDay stays on today, and the picker then shows a
      // different day than the cell. The modal's own past-time guard covers the
      // last minute of the day, where no future slot is left.
      const soonest = new Date(now + 60 * 60_000);
      soonest.setMinutes(0, 0, 0);
      const endOfDay = new Date(y, mo - 1, da, 23, 59, 0, 0);
      when.setTime(Math.min(soonest.getTime(), endOfDay.getTime()));
    }
    setSelectedDay(dayKey);
    setCreateIso(when.toISOString());
  };

  const cancelScheduled = async (id: string) => {
    setSavingId(id);
    try {
      await apiDelete(`/api/schedule/${id}`);
      await mutate();
      setSelected(null);
      setConfirmCancelId(null);
    } finally {
      setSavingId(null);
    }
  };

  const rescheduleScheduled = async (id: string, whenIso: string) => {
    setSavingId(id);
    try {
      await apiPatch(`/api/schedule/${id}`, { scheduledAt: whenIso });
      await mutate();
    } finally {
      setSavingId(null);
    }
  };

  const weekdayLabels = useMemo(() => {
    const base = startOfWeek(new Date());
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      return d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
    });
  }, []);

  return (
    <>
      {/* Month nav header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button className="btn sm" onClick={() => stepMonth(-1)} aria-label="Previous month">
          <Icon name="chevron_left" size={12} />
        </button>
        <div className="mono" style={{ flex: 1, textAlign: 'center', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
          {monthLabel}
        </div>
        <button className="btn sm" onClick={() => stepMonth(1)} aria-label="Next month">
          <Icon name="chevron_right" size={12} />
        </button>
        <button
          className="btn sm"
          onClick={() => {
            const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
            setMonthCursor(d);
            setSelectedDay(ymd(new Date()));
          }}
        >
          Today
        </button>
      </div>

      {unauth && (
        <div style={{ padding: 12, background: 'rgba(124,77,255,0.05)', border: '1px solid rgba(124,77,255,0.2)', borderRadius: 10, fontSize: 12.5, marginBottom: 12 }}>
          Demo calendar — <Link href="/sign-in?next=/dashboard" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>sign in</Link> to see your real schedule.
        </div>
      )}

      {/* Month grid */}
      <div className="cal-month">
        <div className="cal-month-dow">
          {weekdayLabels.map((w, i) => <div key={i} className="mono">{w}</div>)}
        </div>
        <div className="cal-month-grid">
          {cells.map((d, i) => {
            const key = ymd(d);
            const inMonth = d.getMonth() === monthCursor.getMonth();
            const isToday = key === todayKey;
            const isSel = key === selectedDay;
            const evs = byDate.get(key) ?? [];
            const pastDay = isPastDay(key);
            return (
              <button
                key={i}
                className={`cal-month-cell${inMonth ? '' : ' out'}${isToday ? ' today' : ''}${isSel ? ' sel' : ''}`}
                // Single click browses (reveals the day's posts below); double
                // click creates, mirroring the week grid's click-to-schedule.
                onClick={() => setSelectedDay(key)}
                onDoubleClick={() => openCreateFor(key)}
                title={pastDay ? undefined : 'Double-click to schedule a post'}
              >
                <span className="dnum">{d.getDate()}</span>
                {evs.length > 0 && (
                  <span className="dots">
                    {evs.slice(0, 4).map((e, j) => (
                      <span key={j} className="dot" style={{ background: TYPE_DOT[e.type] }} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected-day detail */}
      <div className="cal-month-day">
        <div className="cal-month-day-head">
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          </span>
          {/* Creates *for the selected day* rather than dumping the user into
              compose with no date — that round trip lost the day they picked. */}
          <button
            className="btn sm primary"
            onClick={() => openCreateFor(selectedDay)}
            disabled={isPastDay(selectedDay)}
            title={isPastDay(selectedDay) ? 'That day has already passed' : undefined}
          >
            <Icon name="plus" size={11} /> New post
          </button>
        </div>
        {selectedEvents.length === 0 ? (
          <div style={{ padding: '20px 4px', fontSize: 13, color: 'var(--ink-4)', textAlign: 'center' }}>
            {isPastDay(selectedDay) ? (
              'Nothing was scheduled for this day.'
            ) : (
              <>
                <div style={{ marginBottom: 10 }}>Nothing scheduled for this day.</div>
                <button className="btn sm" onClick={() => openCreateFor(selectedDay)}>
                  <Icon name="sparkle" size={11} /> Schedule a post
                </button>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {selectedEvents.map((e) => (
              <button
                key={e.row.id}
                className="cal-month-event"
                onClick={() => setSelected(e.row)}
              >
                <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)', flexShrink: 0 }}>{e.time}</span>
                <span style={{ flex: 1, minWidth: 0, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13 }}>
                  {(e.type === 'failed' || e.type === 'canceled') && (
                    <span style={{ color: 'var(--bad)', fontFamily: 'var(--mono)', fontSize: 10, marginRight: 6, textTransform: 'uppercase' }}>{TYPE_LABEL[e.type]}</span>
                  )}
                  {e.title || '(empty)'}
                </span>
                <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                  {e.plats.map((p) => (
                    <span key={p} className={`pglyph ${p}`} style={{ width: 16, height: 16, fontSize: 9, borderRadius: 3 }}>
                      {platGlyphs[p]}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Quick-compose for the clicked day — same modal the week grid uses,
          plus a time picker since a month cell carries no hour. */}
      {createIso && (
        <QuickComposeModal
          whenIso={createIso}
          onWhenChange={setCreateIso}
          onClose={() => setCreateIso(null)}
          onScheduled={mutate}
        />
      )}

      {/* Detail / reschedule modal — mirrors the desktop one. */}
      {selected && (
        <div className="modal-scrim" onClick={() => setSelected(null)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 92vw)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span className={`pglyph ${PLATFORM_TO_SHORT[selected.platform]}`} style={{ width: 22, height: 22 }}>
                {platGlyphs[PLATFORM_TO_SHORT[selected.platform]]}
              </span>
              <h3 style={{ margin: 0, fontSize: 15, letterSpacing: '-0.01em' }}>
                {selected.platform} · {new Date(selected.scheduledAt).toLocaleString()}
              </h3>
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', padding: 14, background: 'var(--bg-sunk)', borderRadius: 10, marginBottom: 14, color: 'var(--ink-2)' }}>
              {selected.text}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>Reschedule</label>
              <input
                type="datetime-local"
                value={rescheduleVal}
                onChange={(e) => setRescheduleVal(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--line-2)', borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 12 }}
              />
              <button
                className="btn sm"
                disabled={
                  savingId === selected.id ||
                  !rescheduleVal ||
                  rescheduleVal === toLocalInputValue(selected.scheduledAt) ||
                  Number.isNaN(new Date(rescheduleVal).getTime())
                }
                onClick={() => {
                  const v = new Date(rescheduleVal);
                  if (!Number.isNaN(v.getTime())) rescheduleScheduled(selected.id, v.toISOString());
                }}
              >
                <Icon name="calendar" size={11} /> {savingId === selected.id ? 'Saving…' : 'Reschedule'}
              </button>
              <div style={{ flex: 1 }} />
              {selected.platformPostUrl && (
                <a className="btn sm ghost" href={selected.platformPostUrl} target="_blank" rel="noreferrer">
                  <Icon name="arrow_right" size={11} /> View
                </a>
              )}
              <button className="btn sm" onClick={() => setConfirmCancelId(selected.id)} disabled={savingId === selected.id}>
                <Icon name="x" size={11} /> Cancel post
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmCancelId && (
        <div className="modal-scrim" onClick={() => { if (!savingId) setConfirmCancelId(null); }}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ width: 'min(420px, 92vw)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 15, letterSpacing: '-0.01em' }}>Cancel this scheduled post?</h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
              It will not be published. This can&apos;t be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirmCancelId(null)} disabled={!!savingId}>Keep it</button>
              <button className="btn primary" onClick={() => cancelScheduled(confirmCancelId)} disabled={!!savingId}>
                {savingId ? 'Canceling…' : 'Cancel post'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

function sameWeek(a: Date, weekStart: Date) {
  const ws = startOfWeek(a).getTime();
  return ws === weekStart.getTime();
}

export default CalendarPage;
