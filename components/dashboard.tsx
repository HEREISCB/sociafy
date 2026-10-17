'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSWRConfig } from 'swr';
import { addDays, addHours, addMinutes, format, isSameMonth, startOfDay, startOfHour } from 'date-fns';
import { Icon } from './icons';
import { apiDelete, apiPatch, apiPost, fetcher, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { healthFor, type HealthAccount } from '../lib/ui/health';
import type { PlanView } from '../lib/agent/plan';
import type { Platform } from '../lib/db/schema';
import {
  KIND_LABEL, LATER, NO_TIME, buckets, calendarItems, dayKey, fmtSlot, groupRows, idOf, isVideo, itemMedia, itemPlatforms, kindOf, movable,
  moveToDay, nextToReview, progress, skipMessage, statusLabel, toReview, toneOf, type Bucket, type CalItem, type ScheduledRow, type Skipped,
} from './calendar/model';
import { Glyphs } from './calendar/glyphs';
import { ReviewPanel, Tick, type PostAction } from './calendar/review';

type Account = HealthAccount & { id: string; platform: Platform };
type Approved = { draftId: string; scheduledAt: string | null; reslotted: boolean; rendering?: true };

/** generate's 409 reasons (lib/agent/run.ts) → the one place that fixes each. */
const BLOCKED: Record<string, { text: string; href: string; cta: string }> = {
  no_accounts: { text: 'Connect an account so there is somewhere to post.', href: '/settings/connections', cta: 'Connect an account' },
  no_allowed_platforms: { text: 'Turn on at least one account for autopilot.', href: '/autopilot', cta: 'Open Autopilot' },
  no_niches: { text: 'Pick what to write about first.', href: '/autopilot', cta: 'Pick topics' },
  no_settings: { text: 'Set up autopilot first.', href: '/autopilot', cta: 'Set up Autopilot' },
  credit_cap: { text: 'This week’s credit cap is reached.', href: '/autopilot', cta: 'Raise the cap' },
  insufficient_credits: { text: 'You’re out of credits.', href: '/settings/plan', cta: 'Top up' },
};

/** A drop or a pick closer than this to now would post at once; the server re-slots it anyway. */
const SOON_MS = 5 * 60_000;
/** Wall clock for event handlers (the render path uses the ticking `now`). */
const clock = () => Date.now();
const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Ticking "now" in epoch ms; 0 until mounted so server and client first paints agree. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick);
    const id = setInterval(tick, intervalMs);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [intervalMs]);
  return now;
}

/** The reviewed count ticks up to its new value (ease-out, 420ms). */
function useCountUp(to: number) {
  const [shown, setShown] = useState(to);
  const from = useRef(to);
  useEffect(() => {
    const start = from.current;
    from.current = to;
    const t0 = performance.now();
    let raf = 0;
    const f = (t: number) => {
      const k = reduced() ? 1 : Math.min(1, (t - t0) / 420);
      setShown(Math.round(start + (to - start) * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return shown;
}

type Toast = { text: string; id: number; error?: boolean; undo?: () => void };

export default function Dashboard() {
  const now = useNow(60_000);
  const today = useMemo(() => (now ? startOfDay(new Date(now)) : null), [now]);

  const planKey = '/api/plan?days=7';
  const planApi = useApi<PlanView>(planKey, {
    // While a plan run drafts, poll; otherwise sit still.
    refreshInterval: (d) => ((d as PlanView | undefined)?.generating ? 4000 : 0),
  });
  const plan = planApi.data;
  const schedKey = today ? `/api/schedule?from=${today.toISOString()}&to=${addDays(today, 7).toISOString()}` : null;
  const schedApi = useApi<ScheduledRow[]>(schedKey);
  const { data: accounts } = useApi<Account[]>('/api/accounts');

  const { mutate } = useSWRConfig();
  /** Refetch plan and schedule together so a just-approved draft never vanishes between the two. */
  const refresh = useCallback(async () => {
    const keys = [planKey, schedKey].filter((k): k is string => !!k);
    try {
      const data = await Promise.all(keys.map((k) => fetcher(k)));
      keys.forEach((k, i) => mutate(k, data[i], { revalidate: false }));
    } catch {
      keys.forEach((k) => mutate(k));
    }
  }, [schedKey, mutate]);

  const [toast, setToast] = useState<Toast | null>(null);
  const notice = (text: string, undo?: () => void) => setToast({ text, undo, id: clock() });
  const failure = (text: string) => setToast({ text, error: true, id: clock() });
  const closeToast = useCallback(() => setToast(null), []);

  /** Approves and skips show at once; the server catches up on refresh. */
  const [acted, setActed] = useState<Map<string, 'approved' | 'skipped'>>(new Map());
  const act = (id: string, v: 'approved' | 'skipped' | null) =>
    setActed((m) => { const n = new Map(m); if (v) n.set(id, v); else n.delete(id); return n; });
  /** Draft ids just approved: their tick draws in. */
  const [just, setJust] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!just.size) return;
    const t = setTimeout(() => setJust(new Set()), 1200);
    return () => clearTimeout(t);
  }, [just]);

  const items = useMemo(() => {
    const review = (plan?.review ?? [])
      .filter((d) => acted.get(d.id) !== 'skipped')
      .map((d) => (acted.get(d.id) === 'approved' ? { ...d, approved: true } : d));
    return calendarItems(review, groupRows(schedApi.data ?? []));
  }, [plan, schedApi.data, acted]);
  const strip = useMemo(() => (today ? buckets(items, today) : []), [items, today]);
  const order = useMemo(() => strip.flatMap((b) => b.items), [strip]);

  const [selId, setSelId] = useState<string | null>(null);
  const [dir, setDir] = useState(0);
  /** A day tile picked that has no posts: show it empty. */
  const [dayPick, setDayPick] = useState<string | null>(null);
  // Default: the first post to review on a day (the buffer/spinner card waits its turn).
  const sel = order.find((i) => idOf(i) === selId)
    ?? strip.filter((b) => b.day).flatMap((b) => b.items).find(toReview) ?? order.find(toReview) ?? order[0] ?? null;
  const selIndex = sel ? order.indexOf(sel) : -1;
  const shownKey = dayPick ?? strip.find((b) => sel && b.items.includes(sel))?.key ?? null;
  const shown = strip.find((b) => b.key === shownKey) ?? null;

  const select = (it: CalItem, d?: number) => {
    setDir(d ?? (order.indexOf(it) >= selIndex ? 1 : -1));
    setSelId(idOf(it));
    setDayPick(null);
  };
  const step = (n: 1 | -1) => { if (order.length) select(order[(selIndex + n + order.length) % order.length], n); };
  const advance = (next: CalItem | null) => {
    if (next) setTimeout(() => select(next, 1), reduced() ? 0 : 320);
  };

  const { done, total } = progress(items);
  const count = useCountUp(done);
  const approvable = items.filter((i): i is Extract<CalItem, { kind: 'draft' }> => toReview(i) && i.kind === 'draft' && !i.draft.tooLong.length);

  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { failure(friendlyApiError(e)); } finally { setBusy(false); void refresh(); }
  };

  const generate = () =>
    run(async () => {
      const r = await fetch('/api/plan/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ horizonDays: 7 }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.status === 'blocked') return setBlocked(j.reason);
      if (j.status === 'started') setDrafting(j.planned);
      // 'running': a run (e.g. the one onboarding kicked) already holds the lease; GET shows it as generating.
      else if (!r.ok && j.status !== 'running') throw new Error(`${r.status}: ${JSON.stringify(j)}`);
    });

  const approve = async (it: CalItem, body: string) => {
    if (it.kind !== 'draft') return;
    const d = it.draft;
    const next = nextToReview(order, d.id);
    act(d.id, 'approved');
    setJust(new Set([d.id]));
    advance(next);
    try {
      if (body !== d.body) await apiPatch(`/api/drafts/${d.id}`, { body });
      const r = await apiPost<{ approved: Approved[]; skipped: Skipped[] }>('/api/plan/approve', { draftIds: [d.id] });
      const a = r.approved[0];
      if (r.skipped[0]) { act(d.id, null); failure(`Not approved. ${skipMessage(r.skipped[0])}`); }
      else if (a?.reslotted && a.scheduledAt) notice(`Its time had passed. Scheduled for ${fmtSlot(new Date(a.scheduledAt))}.`);
      else if (!next) notice(`All ${total} reviewed.`);
    } catch (e) {
      act(d.id, null);
      failure(friendlyApiError(e));
    }
    void refresh();
  };

  const skip = async (it: CalItem) => {
    if (it.kind !== 'draft') return;
    const d = it.draft;
    const next = nextToReview(order, d.id);
    act(d.id, 'skipped');
    advance(next);
    try {
      await apiPost('/api/plan/skip', { draftId: d.id });
      // Skip archives the draft and clears its slot; undo puts both back.
      notice('Skipped.', () => run(async () => {
        await apiPatch(`/api/drafts/${d.id}`, { status: 'draft', plannedAt: d.plannedAt });
        act(d.id, null);
        setSelId(d.id);
      }));
    } catch (e) {
      act(d.id, null);
      failure(friendlyApiError(e));
    }
    void refresh();
  };

  const approveAll = () =>
    run(async () => {
      const ids = approvable.map((i) => i.draft.id);
      ids.forEach((id) => act(id, 'approved'));
      setJust(new Set(ids));
      const r = await apiPost<{ approved: Approved[]; skipped: (Skipped & { draftId: string })[] }>('/api/plan/approve', { all: true });
      r.skipped.forEach((s) => act(s.draftId, null));
      if (r.skipped.length) failure(`${r.skipped.length} not approved. ${skipMessage(r.skipped[0])}`);
      else notice(`Approved ${r.approved.length}.`);
    });

  /** Move a post (drag onto a day, or the time picker). Undo puts it back. */
  const reschedule = (it: CalItem, at: Date) => {
    if (at.getTime() < clock() + SOON_MS) return failure('That time has passed. Pick a later day or time.');
    if (it.at && at.getTime() === it.at.getTime()) return;
    const put = (when: Date | null) =>
      it.kind === 'draft'
        ? apiPatch(`/api/drafts/${it.draft.id}`, { plannedAt: when?.toISOString() ?? null })
        : Promise.all(it.group.rows.map((r) => apiPatch(`/api/schedule/${r.id}`, { scheduledAt: when!.toISOString() })));
    const from = it.at;
    return run(async () => {
      await put(at);
      notice(`Moved to ${fmtSlot(at)}.`, () => run(async () => { await put(from); notice('Moved back.'); }));
    });
  };

  const postAction = (it: CalItem, a: PostAction) => {
    if (it.kind !== 'post') return;
    const rows = it.group.rows;
    const later = it.at.getTime() > clock() + SOON_MS ? it.at : startOfHour(addHours(new Date(), 1));
    const each = (fn: (id: string) => Promise<unknown>) => Promise.all(rows.map((r) => fn(r.id)));
    return run(async () => {
      if (a === 'cancel') { await each((id) => apiDelete(`/api/schedule/${id}`)); notice('Canceled.', () => postAction({ ...it, group: { ...it.group, status: 'canceled', error: 'user_canceled' } }, 'restore')); }
      if (a === 'retry') { await each((id) => apiPatch(`/api/schedule/${id}`, { scheduledAt: addMinutes(new Date(), 5).toISOString() })); notice('Queued to retry in 5 minutes.'); }
      if (a === 'restore') { await each((id) => apiPatch(`/api/schedule/${id}`, { scheduledAt: later.toISOString() })); notice(`Restored for ${fmtSlot(later)}.`); }
    });
  };

  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drop = (b: Bucket, key: string) => {
    const it = items.find((i) => i.key === key);
    if (it && b.day) reschedule(it, moveToDay(it, b.day));
  };

  const unhealthy = now ? (accounts ?? []).filter((a) => !a.isStub && healthFor(a, now).tone === 'bad') : [];
  const noAccounts = accounts?.length === 0;
  const block = blocked ?? (plan?.counts.missing && !plan.generating ? plan.blocked : null);
  const blockInfo = block ? BLOCKED[block] : undefined;
  const generating = !!plan?.generating;
  const planLabel = `Plan this week${plan?.estimatedCredits ? ` · ≈${plan.estimatedCredits} credits` : ''}`;

  const range = today && `${format(today, 'MMM d')} – ${format(addDays(today, 6), isSameMonth(today, addDays(today, 6)) ? 'd' : 'MMM d')}`;
  const loading = !today || !plan || !schedApi.data;

  let body: React.ReactNode;
  if (planApi.error) {
    body = <p className="home__alert" role="alert">Couldn’t load your plan. <button type="button" className="btn sm" onClick={() => refresh()}>Try again</button></p>;
  } else if (noAccounts && !items.length) {
    body = (
      <Empty title="Connect an account to start" text="Sociafy plans a week of posts for the accounts you connect. Nothing posts until you approve it.">
        <Link className="btn primary home__cta" href="/settings/connections">Connect an account</Link>
      </Empty>
    );
  } else if (loading || (generating && !items.length)) {
    body = <Skeleton line={generating ? `Drafting ${drafting ?? plan?.counts.missing ?? ''} posts…` : null} />;
  } else if (!items.length) {
    body = (
      <Empty title="Plan this week" text="One topic a day, written for each of your platforms in your voice. Nothing posts until you approve it.">
        {blockInfo
          ? <p className="home__note">{blockInfo.text} <Link href={blockInfo.href}>{blockInfo.cta} →</Link></p>
          : <button type="button" className="btn primary home__cta" onClick={generate} disabled={busy}>{busy ? 'Starting…' : planLabel}</button>}
      </Empty>
    );
  } else {
    body = (
      <>
        <section className="home__plan" aria-label="This week">
          <div className={`strip${dragging ? ' is-dragging' : ''}`} role="tablist" aria-label="Days">
            {strip.map((b) => (
              <DayTile
                key={b.key}
                b={b}
                today={today!}
                on={b.key === shownKey}
                over={over === b.key}
                onClick={() => { const f = b.items.find(toReview) ?? b.items[0]; if (f) select(f); else setDayPick(b.key); }}
                drop={b.day ? {
                  onDragOver: (e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(b.key); } },
                  onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); },
                  onDrop: (e) => { e.preventDefault(); setOver(null); drop(b, e.dataTransfer.getData('text/x-cal')); },
                } : undefined}
              />
            ))}
          </div>
          <div key={shownKey} className="dposts">
            {shown?.items.length ? shown.items.map((i) => (
              <PostCard
                key={i.key}
                item={i}
                bucket={shown}
                on={i === sel}
                just={just.has(idOf(i))}
                dragged={dragging === i.key}
                onClick={() => select(i)}
                onDrag={(k) => { setDragging(k); if (!k) setOver(null); }}
              />
            )) : <p className="dposts__empty">Nothing planned. Drag a post onto this day.</p>}
          </div>
        </section>
        {sel && plan && (
          <ReviewPanel
            key={idOf(sel)}
            item={sel}
            index={selIndex}
            total={order.length}
            dir={dir}
            now={now}
            today={today!}
            limits={plan.limits}
            onStep={step}
            onApprove={(b) => approve(sel, b)}
            onSkip={() => skip(sel)}
            onSaveBody={(b) => run(async () => { await apiPatch(`/api/drafts/${idOf(sel)}`, { body: b }); })}
            onReschedule={(at) => reschedule(sel, at)}
            onPost={(a) => postAction(sel, a)}
          />
        )}
      </>
    );
  }

  const left = items.filter(toReview).length;
  return (
    <div className="home">
      <header className="home__head">
        <h1 className="home__title">This week <span className="tnum">{range}</span></h1>
        {total > 0 && (
          <div className="home__meter" role="status">
            <span className="tnum"><b>{count}</b> of {total} reviewed</span>
            <span className={`bar${done === total ? ' is-done' : ''}`}><i style={{ width: `${(done / total) * 100}%` }} /></span>
          </div>
        )}
        <div className="home__actions">
          {plan?.generating && items.length > 0 && <span className="home__progress" role="status">Drafting {drafting ?? plan.counts.missing} posts…</span>}
          {items.length > 0 && (left > 0 || !plan?.counts.missing || blockInfo ? (
            <button type="button" className="btn home__all" onClick={approveAll} disabled={busy || !approvable.length}>
              {left ? <>Approve all <span className="tnum">{approvable.length}</span></> : 'All reviewed'}
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={generate} disabled={busy || generating}>{planLabel}</button>
          ))}
        </div>
      </header>

      {unhealthy.length > 0 && (
        <p className="home__alert" role="alert">
          {unhealthy.length === 1 ? '1 account needs' : `${unhealthy.length} accounts need`} reconnecting before it can post.{' '}
          <Link href="/settings/connections">Reconnect</Link>
        </p>
      )}
      {schedApi.error && (
        <p className="home__alert" role="alert">Couldn’t load scheduled posts. <button type="button" className="btn sm" onClick={() => refresh()}>Try again</button></p>
      )}

      {body}
      {toast && <ToastBar key={toast.id} toast={toast} onClose={closeToast} />}
    </div>
  );
}

type DropProps = Pick<React.HTMLAttributes<HTMLButtonElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;

function DayTile({ b, today, on, over, onClick, drop }: { b: Bucket; today: Date; on: boolean; over: boolean; onClick: () => void; drop?: DropProps }) {
  const n = b.items.length;
  const doneN = n - b.toReview;
  const isToday = b.day && dayKey(b.day) === dayKey(today);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className={`dtile${on ? ' is-on' : ''}${isToday ? ' is-today' : ''}${over ? ' is-over' : ''}${drop ? ' is-drop' : ''}${b.day ? '' : ' is-edge'}`}
      onClick={onClick}
      {...drop}
    >
      <span className="dtile__h">
        {b.key === NO_TIME ? <><span className="dtile__spin" aria-hidden="true" /><span className="sr-only">Unscheduled posts</span></> : b.key === LATER ? <b>Later</b>
          : <><b>{isToday ? 'Today' : format(b.day!, 'EEE')}</b><span className="tnum">{format(b.day!, 'd')}</span></>}
      </span>
      {b.topic && <span className="dtile__tp">{b.topic}</span>}
      <span className="dtile__sum tnum">
        {n ? <>{n} post{n > 1 ? 's' : ''} · {b.toReview ? <em>{b.toReview} to review</em> : 'all set'}</> : 'No posts'}
      </span>
      <span className="mb"><i className={n && !b.toReview ? 'is-ok' : ''} style={{ width: `${n ? (doneN / n) * 100 : 0}%` }} /></span>
    </button>
  );
}

function PostCard({ item, bucket, on, just, dragged, onClick, onDrag }: {
  item: CalItem; bucket: Bucket; on: boolean; just: boolean; dragged: boolean; onClick: () => void; onDrag: (key: string | null) => void;
}) {
  const tone = toneOf(item);
  const can = movable(item);
  const when = !item.at ? 'No time'
    : bucket.key === NO_TIME ? 'Time passed'
    : bucket.key === LATER ? format(item.at, 'EEE d · h:mm a')
    : format(item.at, 'h:mm a');
  return (
    <button
      type="button"
      className={`pcard pcard--${tone}${on ? ' is-on' : ''}${just ? ' is-just' : ''}${dragged ? ' is-dragged' : ''}`}
      aria-pressed={on}
      aria-label={`${KIND_LABEL[kindOf(item)]} at ${when}, ${statusLabel(item)}`}
      onClick={onClick}
      draggable={can || undefined}
      onDragStart={can ? (e) => {
        e.dataTransfer.setData('text/x-cal', item.key);
        e.dataTransfer.effectAllowed = 'move';
        // After the browser snapshots the drag image, so the ghost isn't dimmed.
        setTimeout(() => onDrag(item.key));
      } : undefined}
      onDragEnd={can ? () => onDrag(null) : undefined}
    >
      {can && (
        <svg className="pcard__grip" width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
          {[2, 6, 10].flatMap((y) => [<circle key={`a${y}`} cx="2" cy={y} r="1.1" />, <circle key={`b${y}`} cx="6" cy={y} r="1.1" />])}
        </svg>
      )}
      <Thumb item={item} />
      <span className="pcard__main">
        <span className="pcard__tm tnum">{when}</span>
        <span className="pcard__lb">{KIND_LABEL[kindOf(item)]}</span>
        <Glyphs platforms={itemPlatforms(item)} />
      </span>
      <span className="pcard__st" title={statusLabel(item)}>
        {tone === 'review' ? <i className="rdot" /> : tone === 'failed' ? <i className="rdot is-err" /> : tone === 'canceled' ? <i className="skp" /> : <Tick />}
      </span>
    </button>
  );
}

/** Card thumbnail: the image, a video's first frame, or ruled lines for a text post. */
function Thumb({ item }: { item: CalItem }) {
  const m = itemMedia(item);
  const k = kindOf(item);
  return (
    <span className={`thumb thumb--${k}`} aria-hidden="true">
      {m && isVideo(m) ? <video src={`${m.url}#t=0.1`} preload="metadata" muted playsInline />
        // eslint-disable-next-line @next/next/no-img-element
        : m ? <img src={m.url} alt="" loading="lazy" /> : null}
      {k === 'video' && <span className="thumb__play" />}
    </span>
  );
}

function Empty({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="home-empty">
      <span className="home-empty__spark"><Icon name="sparkle" size={20} /></span>
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </div>
  );
}

function Skeleton({ line }: { line: string | null }) {
  return (
    <>
      <section className="home__plan" aria-busy="true" aria-label="Loading">
        <div className="strip">{Array.from({ length: 7 }, (_, i) => <div key={i} className="sk sk--tile" />)}</div>
        <div className="dposts">{Array.from({ length: 4 }, (_, i) => <div key={i} className="sk sk--card" />)}</div>
      </section>
      <section className="hr">
        <div className="hr__stage"><div className="sk sk--media" /></div>
        <div className="hr__body">
          {line && <p className="home__progress" role="status">{line}</p>}
          <div className="sk" style={{ height: 10, width: '40%' }} />
          <div className="sk" style={{ height: 14, width: '92%' }} />
          <div className="sk" style={{ height: 14, width: '64%' }} />
          <div className="sk" style={{ height: 30, width: 200, borderRadius: 999 }} />
        </div>
      </section>
    </>
  );
}

/** Result of a move/approve/skip, with Undo where there is one. Errors linger longer. */
function ToastBar({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, toast.error ? 8000 : toast.undo ? 5000 : 3000);
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
