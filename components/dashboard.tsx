'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { useSWRConfig } from 'swr';
import {
  addDays, addMonths, addWeeks, differenceInCalendarMonths, differenceInCalendarWeeks, endOfMonth, format, isSameMonth, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { Icon } from './icons';
import { apiPatch, apiPost, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { healthFor, type HealthAccount } from '../lib/ui/health';
import type { PlanView } from '../lib/agent/plan';
import type { Platform } from '../lib/db/schema';
import { byDay, calendarItems, groupRows, moveToDay, planStatus, type CalItem, type ScheduledRow } from './calendar/model';
import { AgendaView, DragCtx, MonthView, WeekView } from './calendar/views';
import { PostPanel } from './calendar/panel';
import { TrayCard, fmtSlot, skipMessage } from './plan/review-card';

type Account = HealthAccount & { id: string; platform: Platform };
type View = 'week' | 'month';

/** generate's 409 reasons (lib/agent/run.ts) → the one place that fixes each. */
const BLOCKED: Record<string, { text: string; href: string; cta: string }> = {
  no_accounts: { text: 'Connect an account so there is somewhere to post.', href: '/settings/connections', cta: 'Connect an account' },
  no_allowed_platforms: { text: 'Turn on at least one account for autopilot.', href: '/autopilot', cta: 'Open Autopilot' },
  no_niches: { text: 'Pick what to write about first.', href: '/autopilot', cta: 'Pick topics' },
  no_settings: { text: 'Set up autopilot first.', href: '/autopilot', cta: 'Set up Autopilot' },
  credit_cap: { text: 'This week’s credit cap is reached.', href: '/autopilot', cta: 'Raise the cap' },
  insufficient_credits: { text: 'You’re out of credits.', href: '/settings/plan', cta: 'Top up' },
};

const weekOf = (d: Date) => startOfWeek(d, { weekStartsOn: 1 });
/** A drop or a pick closer than this to now would post at once; the server re-slots it anyway. */
const SOON_MS = 5 * 60_000;

/** Ticking "now" in epoch ms; 0 until mounted so server and client first paints agree. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Below 640px the grids are too cramped: phones get the agenda list. */
const PHONE = '(max-width: 639px)';
const usePhone = () =>
  useSyncExternalStore(
    (cb) => { const m = window.matchMedia(PHONE); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );

export default function Dashboard() {
  const now = useNow(60_000);
  const phone = usePhone();
  const [view, setViewState] = useState<View>('week');
  // ?view=week|month — read once on mount (no useSearchParams, so no Suspense boundary needed).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') === 'month') setViewState('month');
  }, []);
  /** Periods from the current one (−1 = last week/month). */
  const [offset, setOffset] = useState(0);

  const today = now ? startOfDay(new Date(now)) : null;
  const range = (() => {
    if (!today) return null;
    if (view === 'week') {
      const start = addWeeks(weekOf(today), offset);
      return { start, from: start, to: addDays(start, 7), length: 7 };
    }
    const start = addMonths(startOfMonth(today), offset);
    const from = weekOf(start);
    return { start, from, to: addDays(from, 42), length: endOfMonth(start).getDate() };
  })();

  const setView = (v: View) => {
    if (v === view) return;
    // Keep the period in view: the month holding this week, or that month's first week.
    if (range && today) setOffset(v === 'month' ? differenceInCalendarMonths(range.start, today) : differenceInCalendarWeeks(range.start, today, { weekStartsOn: 1 }));
    setViewState(v);
    const url = new URL(window.location.href);
    url.searchParams.set('view', v);
    window.history.replaceState(null, '', url);
  };
  const showWeekOf = (day: Date) => {
    if (!today) return;
    setViewState('week');
    setOffset(differenceInCalendarWeeks(day, today, { weekStartsOn: 1 }));
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'week');
    window.history.replaceState(null, '', url);
  };

  const days = view === 'month' ? 30 : 7;
  // While a plan run drafts, poll; otherwise sit still.
  const planApi = useApi<PlanView>(`/api/plan?days=${days}`, {
    refreshInterval: (d) => ((d as PlanView | undefined)?.generating ? 4000 : 0),
  });
  const plan = planApi.data;
  const schedApi = useApi<ScheduledRow[]>(range ? `/api/schedule?from=${range.from.toISOString()}&to=${range.to.toISOString()}` : null);
  const { data: accounts } = useApi<Account[]>('/api/accounts');

  const { mutate } = useSWRConfig();
  const refresh = useCallback(() => {
    mutate((k) => typeof k === 'string' && (k.startsWith('/api/schedule') || k.startsWith('/api/plan')));
  }, [mutate]);

  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const setNotice = (text: string) => setToast({ text, id: Date.now() });
  const setFailure = (text: string) => setToast({ text, error: true, id: Date.now() });
  const [dragging, setDragging] = useState<string | null>(null);
  /** Draft id of the post that just moved, so its card can flash in its new spot. */
  const [landed, setLanded] = useState<string | null>(null);
  const drag = useMemo(() => ({ dragging, setDragging, landed }), [dragging, landed]);
  useEffect(() => {
    if (!landed) return;
    const t = setTimeout(() => setLanded(null), 2500);
    return () => clearTimeout(t);
  }, [landed]);
  const closeToast = useCallback(() => setToast(null), []);
  const [selected, setSelected] = useState<CalItem | null>(null);

  const unhealthy = now ? (accounts ?? []).filter((a) => !a.isStub && healthFor(a, now).tone === 'bad') : [];

  const review = useMemo(() => plan?.review ?? [], [plan]);
  const items = useMemo(() => calendarItems(review, groupRows(schedApi.data ?? [])), [review, schedApi.data]);
  const dayMap = useMemo(() => byDay(items), [items]);
  const tray = useMemo(
    () => review.filter((d) => !d.plannedAt).map((d) => ({ kind: 'draft' as const, key: `d${d.id}`, at: null, draft: d })),
    [review],
  );
  // The open panel follows fresh data (a saved time moves a tray draft onto the calendar).
  const open = selected ? [...items, ...tray].find((i) => i.key === selected.key) ?? selected : null;

  const ready = review.filter((r) => !r.approved);
  const approvable = ready.filter((r) => !r.tooLong.length);
  const block = blocked ?? (accounts && accounts.length === 0 ? 'no_accounts' : null) ?? (plan?.counts.missing && !plan.generating ? plan.blocked : null);
  const blockInfo = block ? BLOCKED[block] : undefined;
  const period = view;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setToast(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setFailure(friendlyApiError(e));
    } finally {
      setBusy(false);
    }
  };
  const generate = () =>
    act(async () => {
      const r = await fetch('/api/plan/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ horizonDays: days }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.status === 'blocked') return setBlocked(j.reason);
      if (j.status === 'started') setDrafting(j.planned);
      // 'running': a run (e.g. the one onboarding kicked) already holds the lease; GET shows it as generating.
      else if (!r.ok && j.status !== 'running') throw new Error(`${r.status}: ${JSON.stringify(j)}`);
    });
  const approveAll = () =>
    act(async () => {
      const r = await apiPost<{ approved: unknown[]; skipped: { reason: string; platforms?: Platform[] }[] }>('/api/plan/approve', { all: true });
      if (r.skipped.length) setFailure(`${r.skipped.length} not approved. ${skipMessage(r.skipped[0])}`);
      else setNotice(`Approved ${r.approved.length}.`);
    });

  /** Drag to another day: same time of day; an undated draft lands at 10 AM. */
  const move = (key: string, day: Date) => {
    const it = [...items, ...tray].find((i) => i.key === key);
    if (!it) return;
    const at = moveToDay(it, day);
    if (at.getTime() < Date.now() + SOON_MS) return setFailure('That time has passed. Pick a later day, or open the post to set a time.');
    if (it.at && at.getTime() === it.at.getTime()) return;
    const put = (when: Date | null) =>
      it.kind === 'draft'
        ? apiPatch(`/api/drafts/${it.draft.id}`, { plannedAt: when?.toISOString() ?? null })
        : Promise.all(it.group.rows.map((r) => apiPatch(`/api/schedule/${r.id}`, { scheduledAt: when!.toISOString() })));
    const from = it.at;
    const id = it.kind === 'draft' ? it.draft.id : it.group.rows[0].draftId;
    act(async () => {
      await put(at);
      setLanded(id);
      setToast({
        text: `Moved to ${fmtSlot(at.toISOString())}.`,
        id: Date.now(),
        undo: () => act(async () => { await put(from); setLanded(id); setNotice('Moved back.'); }),
      });
    });
  };

  // The one action, by state. Blocked states get a quiet banner, not a button.
  let action: ReactNode = null;
  if (plan) {
    if (plan.generating) {
      action = <span className="home__progress" role="status">Drafting {drafting ?? plan.counts.missing} posts…</span>;
    } else if (approvable.length) {
      action = <button className="btn primary" onClick={approveAll} disabled={busy}>{busy ? 'Approving…' : `Approve all ${approvable.length}`}</button>;
    } else if (blockInfo) {
      // banner below carries it
    } else if (plan.counts.missing > 0) {
      action = <button className="btn primary" onClick={generate} disabled={busy}>{busy ? 'Starting…' : `Plan next ${period}${plan.estimatedCredits ? ` · ≈${plan.estimatedCredits} credits` : ''}`}</button>;
    } else if (ready.length) {
      action = <span className="home__progress">Fix the posts marked too long to approve them.</span>;
    } else {
      action = <span className="home__progress">You’re set until {format(new Date(plan.to), 'EEE d MMM')}.</span>;
    }
  }

  const title = !range ? 'Home'
    : offset === 0 ? (view === 'week' ? 'This week' : 'This month')
    : view === 'week' ? `Week of ${format(range.start, 'd MMM')}` : format(range.start, 'MMMM yyyy');
  const rangeLabel = range && (view === 'week'
    ? `${format(range.start, isSameMonth(range.start, addDays(range.start, 6)) ? 'd' : 'd MMM')} – ${format(addDays(range.start, 6), 'd MMM yyyy')}`
    : format(range.start, 'MMMM yyyy'));

  return (
    <div className="home">
      <header className="page-header home__head">
        <div>
          <h1>{title}</h1>
          <p className="page-header__sub">{planApi.error ? 'Couldn’t load your plan.' : plan ? planStatus(plan) : 'Loading…'}</p>
        </div>
        <div className="page-header__actions">
          {planApi.error ? <button className="btn" onClick={() => refresh()}>Try again</button> : action}
        </div>
      </header>

      <div className="home__bar">
        <div className="mode-switch" role="group" aria-label="Calendar view">
          {(['week', 'month'] as const).map((v) => (
            <button key={v} type="button" className={`opt${view === v ? ' active' : ''}`} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'week' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>
        <div className="row home__nav">
          <button type="button" className="icon-btn" aria-label={`Previous ${view}`} onClick={() => setOffset((o) => o - 1)}>
            <Icon name="chevron_left" size={14} />
          </button>
          <span className="home__range tnum" aria-live="polite">{rangeLabel}</span>
          <button type="button" className="icon-btn" aria-label={`Next ${view}`} onClick={() => setOffset((o) => o + 1)}>
            <Icon name="chevron_right" size={14} />
          </button>
          <button type="button" className="btn sm" onClick={() => setOffset(0)} disabled={offset === 0}>Today</button>
        </div>
      </div>

      {unhealthy.length > 0 && (
        <p className="home__alert" role="alert">
          {unhealthy.length === 1 ? '1 account needs' : `${unhealthy.length} accounts need`} reconnecting before it can post.{' '}
          <Link href="/settings/connections">Reconnect</Link>
        </p>
      )}
      {plan && blockInfo && !plan.generating && (
        <p className="home__note">
          {blockInfo.text} <Link href={blockInfo.href}>{blockInfo.cta} →</Link>
        </p>
      )}
      {schedApi.error && (
        <p className="home__alert" role="alert">Couldn’t load scheduled posts. <button type="button" className="btn sm ghost" onClick={refresh}>Try again</button></p>
      )}
      {!phone && <CoachTip />}

      <DragCtx.Provider value={drag}>
      <div className={`home__body${tray.length ? ' has-tray' : ''}${dragging ? ' is-dragging' : ''}`}>
        {range && (
          <div className="home__cal">
            {phone ? (
              <AgendaView start={range.start} length={range.length} days={dayMap} now={now} onOpen={setSelected} />
            ) : view === 'week' ? (
              <WeekView start={range.start} days={dayMap} now={now} onOpen={setSelected} onMove={move} />
            ) : (
              <MonthView month={range.start} days={dayMap} now={now} onOpen={setSelected} onMove={move} onMore={showWeekOf} />
            )}
          </div>
        )}
        {tray.length > 0 && (
          <aside className="home__tray" aria-labelledby="tray-h">
            <h2 id="tray-h" className="home__tray-head">
              Needs a time <span className="tnum">{tray.length}</span>
            </h2>
            <p className="home__tray-sub">{phone ? 'Approve to take the next free slot, or pick a time' : 'Drag a post onto a day to schedule it'}</p>
            <div className="home__tray-list">
              {tray.map((t) => (
                <TrayCard key={t.key} item={t} onOpen={() => setSelected(t)} onDone={(msg) => { setNotice(msg); refresh(); }} />
              ))}
            </div>
          </aside>
        )}
      </div>
      </DragCtx.Provider>

      {open && plan && (
        <PostPanel
          key={open.key}
          item={open}
          limits={plan.limits}
          onClose={() => setSelected(null)}
          refresh={refresh}
          onDone={(msg) => { setSelected(null); setNotice(msg); refresh(); }}
        />
      )}
      {toast && <ToastBar key={toast.id} toast={toast} onClose={closeToast} />}
    </div>
  );
}

type Toast = { text: string; id: number; error?: boolean; undo?: () => void };

/** Bottom-centre toast: results of a move/approve, with Undo for a move. Errors linger longer. */
function ToastBar({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, toast.error ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  return (
    <div className={`home-toast${toast.error ? ' is-error' : ''}`} role={toast.error ? 'alert' : 'status'}>
      <span>{toast.text}</span>
      {toast.undo && <button type="button" className="home-toast__btn" onClick={() => { onClose(); toast.undo!(); }}>Undo</button>}
      <button type="button" className="home-toast__x" aria-label="Dismiss" onClick={onClose}><Icon name="x" size={12} /></button>
    </div>
  );
}

const TIP_KEY = 'sociafy.tip.drag';
const subscribeNone = () => () => {};

/** First-run hint that cards drag; dismissed for good via localStorage. */
function CoachTip() {
  const stored = useSyncExternalStore(subscribeNone, () => localStorage.getItem(TIP_KEY), () => '1');
  const [hidden, setHidden] = useState(false);
  if (stored || hidden) return null;
  return (
    <p className="home__tip">
      <span><strong>Tip:</strong> drag posts between days to reschedule</span>
      <button type="button" className="icon-btn" aria-label="Dismiss tip" onClick={() => { localStorage.setItem(TIP_KEY, '1'); setHidden(true); }}>
        <Icon name="x" size={12} />
      </button>
    </p>
  );
}
