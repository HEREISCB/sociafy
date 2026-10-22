'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSWRConfig } from 'swr';
import { addDays, addHours, addMinutes, format, isSameMonth, startOfDay, startOfHour } from 'date-fns';
import { Icon } from './icons';
import { apiDelete, apiPatch, apiPost, fetcher, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { healthFor, type HealthAccount } from '../lib/ui/health';
import { PLATFORM_LABELS } from '../lib/ui/platforms';
import type { PlanView } from '../lib/agent/plan';
import type { Platform } from '../lib/db/schema';
import {
  KIND_LABEL, LATER, NO_TIME, buckets, calendarItems, dayKey, firstAtRisk, firstOfDay, fmtSlot, groupRows, idOf, isVideo, itemMedia, itemPlatforms,
  itemText, kindOf, movable, moveToDay, nextToReview, progress, restorable, skipMessage, statusLabel, toReview, toneOf, weekFiled,
  type Bucket, type CalItem, type ScheduledRow, type Skipped,
} from './calendar/model';
import { Glyphs } from './calendar/glyphs';
import { ThumbImg } from './thumb-img';
import { seekToPoster } from '../lib/media/motionSeek';
import { ReviewPanel, Tick, type Author, type PostAction } from './calendar/review';

type Account = HealthAccount & Author & { id: string; platform: Platform };
type Approved = { draftId: string; scheduledAt: string | null; reslotted: boolean; rendering?: true };
type Unapproved = { restored: string[]; skipped: { draftId: string; reason: string }[] };

/** generate's 409 reasons (lib/agent/run.ts) → the one place that fixes each. */
const BLOCKED: Record<string, { text: string; href: string; cta: string }> = {
  no_accounts: { text: 'Connect an account so there is somewhere to post.', href: '/settings/connections', cta: 'Connect an account' },
  no_allowed_platforms: { text: 'Turn on at least one account for autopilot.', href: '/autopilot', cta: 'Open Autopilot' },
  no_niches: { text: 'Pick what to write about first.', href: '/autopilot', cta: 'Pick topics' },
  no_settings: { text: 'Set up autopilot first.', href: '/autopilot', cta: 'Set up Autopilot' },
  credit_cap: { text: 'This week’s credit cap is reached.', href: '/autopilot', cta: 'Raise the cap' },
  insufficient_credits: { text: 'You’re out of credits.', href: '/account/billing', cta: 'Top up' },
};

/** A drop or a pick closer than this to now would post at once; the server re-slots it anyway. */
const SOON_MS = 5 * 60_000;
/** Wall clock for event handlers (the render path uses the ticking `now`). */
const clock = () => Date.now();
const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const plats = (ps: Platform[]) => ps.map((p) => PLATFORM_LABELS[p] ?? p).join(', ');
const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, select, [contenteditable]');
/** Compose opens on that day at 10 AM (it ignores a time already gone). */
const composeFor = (day: Date | null) => (day ? `/compose?slot=${encodeURIComponent(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10).toISOString())}` : '/compose');

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

/** The approved card files itself into its day tile (a ghost flies and shrinks away). Skipped when the tile is scrolled out of view. */
function fileAway(id: string, day: string) {
  if (reduced()) return;
  const card = document.querySelector(`[data-post="${CSS.escape(id)}"]`);
  const tile = document.querySelector(`[data-day="${CSS.escape(day)}"]`);
  const strip = tile?.parentElement;
  if (!card || !tile || !strip) return;
  const a = card.getBoundingClientRect(), b = tile.getBoundingClientRect(), s = strip.getBoundingClientRect();
  if (b.left < s.left - 1 || b.right > s.right + 1) return;
  const g = document.createElement('div');
  g.className = 'home-ghost';
  Object.assign(g.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  document.body.appendChild(g);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  g.animate([{ transform: 'none', opacity: 0.9 }, { transform: `translate(${dx}px, ${dy}px) scale(.25)`, opacity: 0 }],
    { duration: 420, easing: 'cubic-bezier(.65,0,.35,1)' }).onfinish = () => g.remove();
}

type Toast = { text: string; id: number; error?: boolean; undo?: () => void };
type Flash = { ids: string[]; days: string[] };

export default function Dashboard() {
  const now = useNow(60_000);
  const today = useMemo(() => (now ? startOfDay(new Date(now)) : null), [now]);

  const planKey = '/api/plan?days=7';
  // Poll while a plan run drafts (4 s) or a clip renders (10 s); otherwise sit still.
  const pollMs = (d?: PlanView) => (d?.generating ? 4000 : d?.counts.rendering ? 10_000 : 0);
  const planApi = useApi<PlanView>(planKey, { refreshInterval: (d) => pollMs(d as PlanView | undefined) });
  const plan = planApi.data;
  const schedKey = today ? `/api/schedule?from=${today.toISOString()}&to=${addDays(today, 7).toISOString()}` : null;
  const schedApi = useApi<ScheduledRow[]>(schedKey, { refreshInterval: pollMs(plan) });
  const { data: accounts } = useApi<Account[]>('/api/accounts');
  const { data: credits } = useApi<{ balance: number }>('/api/credits');

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
  const act = (ids: string[], v: 'approved' | 'skipped' | null) =>
    setActed((m) => { const n = new Map(m); for (const id of ids) { if (v) n.set(id, v); else n.delete(id); } return n; });
  /** Just approved: the card's tick draws, its day tile gets a brief wash. */
  const [flash, setFlash] = useState<Flash>({ ids: [], days: [] });
  useEffect(() => {
    if (!flash.ids.length && !flash.days.length) return;
    const t = setTimeout(() => setFlash({ ids: [], days: [] }), 1200);
    return () => clearTimeout(t);
  }, [flash]);

  const items = useMemo(() => {
    const review = (plan?.review ?? [])
      .filter((d) => acted.get(d.id) !== 'skipped')
      .map((d) => (acted.get(d.id) === 'approved' ? { ...d, approved: true } : d));
    return calendarItems(review, groupRows(schedApi.data ?? []));
  }, [plan, schedApi.data, acted]);
  const strip = useMemo(() => (today ? buckets(items, today) : []), [items, today]);
  const order = useMemo(() => strip.flatMap((b) => b.items), [strip]);
  const generating = !!plan?.generating;

  // While a plan run drafts, a day tile develops the moment its first draft lands.
  const [devDays, setDevDays] = useState<string[]>([]);
  const seen = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const was = seen.current;
    seen.current = new Map(strip.map((b) => [b.key, b.items.length]));
    const fresh = was && generating ? strip.filter((b) => b.items.length && !was.get(b.key)).map((b) => b.key) : [];
    if (!fresh.length) return;
    setDevDays(fresh);
    setTimeout(() => setDevDays([]), 1000);
  }, [strip, generating]);

  // A clip that was rendering has landed (the 10 s poll): its frame and thumb develop in.
  const [developed, setDeveloped] = useState<string[]>([]);
  const renderingIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!plan) return;
    const was = renderingIds.current;
    renderingIds.current = new Set(plan.review.filter((d) => d.rendering).map((d) => d.id));
    const landed = was ? plan.review.filter((d) => was.has(d.id) && !d.rendering && d.media.length) : [];
    if (!landed.length) return;
    setDeveloped(landed.map((d) => d.id));
    setToast({ text: `${landed[0].title?.trim() || 'Your'} video is ready.`, id: clock() });
    setTimeout(() => setDeveloped([]), 1200);
  }, [plan]);

  const [selId, setSelId] = useState<string | null>(null);
  const [dir, setDir] = useState(0);
  /** A day tile picked that has no posts: show it empty. */
  const [dayPick, setDayPick] = useState<string | null>(null);
  /** "Look over a post" from the filed state (any explicit pick does the same). */
  const [lookOver, setLookOver] = useState(false);
  // Default: the first post to review on a day ("No time yet" waits its turn).
  const sel = order.find((i) => idOf(i) === selId)
    ?? strip.filter((b) => b.day).flatMap((b) => b.items).find(toReview) ?? order.find(toReview) ?? order[0] ?? null;
  const selIndex = sel ? order.indexOf(sel) : -1;
  const shownKey = dayPick ?? strip.find((b) => sel && b.items.includes(sel))?.key ?? strip.find((b) => b.day)?.key ?? null;
  const shown = strip.find((b) => b.key === shownKey) ?? null;
  const filed = weekFiled(items) && !lookOver;

  /** The caption as typed; Home owns it so the decision bar approves exactly what's in the box. */
  const [edit, setEdit] = useState<{ id: string; body: string } | null>(null);
  const capRef = useRef<HTMLTextAreaElement>(null);
  const bodyOf = (it: CalItem) => (edit?.id === idOf(it) ? edit.body : itemText(it));
  const body = sel ? bodyOf(sel) : '';
  const overOf = (it: CalItem, b: string) =>
    it.kind !== 'draft' || it.draft.approved ? [] : b !== it.draft.body ? itemPlatforms(it).filter((p) => b.length > (plan?.limits[p] ?? Infinity)) : it.draft.tooLong;
  const over = sel ? overOf(sel, body) : [];

  const select = (it: CalItem, d?: number) => {
    setDir(d ?? (order.indexOf(it) >= selIndex ? 1 : -1));
    setSelId(idOf(it));
    setDayPick(null);
    setLookOver(true);
  };
  const step = (n: 1 | -1) => { if (order.length) select(order[(selIndex + n + order.length) % order.length], n); };
  const advance = (next: CalItem | null) => {
    if (next) setTimeout(() => select(next, 1), reduced() ? 0 : 340);
    else setLookOver(false); // nothing left: the week is filed
  };
  const pickDay = (b: Bucket) => { const f = firstOfDay(b); if (f) select(f); else { setDayPick(b.key); setLookOver(true); } };

  const { done, total } = progress(items);
  const count = useCountUp(done);
  const approvable = items.filter((i): i is Extract<CalItem, { kind: 'draft' }> => toReview(i) && i.kind === 'draft' && !i.draft.tooLong.length);
  const needTrim = items.filter((i) => toReview(i) && i.kind === 'draft' && i.draft.tooLong.length).length;

  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  // "3 of 8 drafted": drafts in review now minus those there when the run started.
  const [genBase, setGenBase] = useState<number | null>(null);
  if (generating && genBase === null && plan) setGenBase(plan.review.length);
  if (!generating && genBase !== null && plan) { setGenBase(null); setDrafting(null); }
  const drafted = plan && genBase !== null ? Math.max(0, plan.review.length - genBase) : 0;
  const draftTotal = drafting ?? drafted + (plan?.counts.missing ?? 0);

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
      if (j.status === 'started') { setDrafting(j.planned); setGenBase(plan?.review.length ?? 0); }
      // 'running': a run (e.g. the one onboarding kicked) already holds the lease; GET shows it as generating.
      else if (!r.ok && j.status !== 'running') throw new Error(`${r.status}: ${JSON.stringify(j)}`);
    });

  /** Undo for Approve / Approve all: back in review at the slots they had. */
  const unapprove = (list: { draftId: string; plannedAt: string | null }[], focus?: string) =>
    run(async () => {
      const r = await apiPost<Unapproved>('/api/plan/unapprove', { items: list });
      act(r.restored, null);
      if (focus && r.restored.includes(focus)) { setSelId(focus); setLookOver(true); }
      if (r.skipped.length) failure(`${r.skipped.length} already posting, so ${r.skipped.length > 1 ? 'they stay' : 'it stays'} scheduled.`);
      else notice(r.restored.length > 1 ? `${r.restored.length} posts are back in review.` : 'Back in review.');
    });

  const approve = async (it: CalItem) => {
    if (it.kind !== 'draft' || !toReview(it)) return;
    const d = it.draft;
    const b = bodyOf(it);
    if (overOf(it, b).length) return;
    const next = nextToReview(order, d.id);
    const day = strip.find((x) => x.items.includes(it))?.key;
    if (day && day !== NO_TIME && day !== LATER) fileAway(d.id, day);
    act([d.id], 'approved');
    setFlash({ ids: [d.id], days: day ? [day] : [] });
    advance(next);
    try {
      if (b !== d.body) await apiPatch(`/api/drafts/${d.id}`, { body: b });
      const r = await apiPost<{ approved: Approved[]; skipped: Skipped[] }>('/api/plan/approve', { draftIds: [d.id] });
      const a = r.approved[0];
      if (r.skipped[0] || !a) { act([d.id], null); failure(`Not approved. ${r.skipped[0] ? skipMessage(r.skipped[0]) : ''}`); }
      else {
        const when = a.rendering ? 'posts when the video lands' : a.scheduledAt ? fmtSlot(new Date(a.scheduledAt)) : 'next free slot';
        notice(`Approved · ${when}${a.reslotted ? ' (next free slot)' : ''}`, () => unapprove([{ draftId: d.id, plannedAt: d.plannedAt }], d.id));
      }
    } catch (e) {
      act([d.id], null);
      failure(friendlyApiError(e));
    }
    void refresh();
  };

  const skip = async (it: CalItem) => {
    if (it.kind !== 'draft' || !toReview(it)) return;
    const d = it.draft;
    const next = nextToReview(order, d.id);
    const card = document.querySelector<HTMLElement>(`[data-post="${CSS.escape(d.id)}"]`);
    const anim = card && !reduced() ? card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], { duration: 200, easing: 'cubic-bezier(.2,0,0,1)', fill: 'forwards' }) : null;
    await anim?.finished.catch(() => {});
    act([d.id], 'skipped');
    advance(next);
    try {
      await apiPost('/api/plan/skip', { draftId: d.id });
      // Skip archives the draft and clears its slot; undo puts both back.
      notice(`Skipped.${it.at && !d.overdue ? ` ${format(it.at, 'EEE')}’s slot is free again.` : ''}`, () => run(async () => {
        await apiPatch(`/api/drafts/${d.id}`, { status: 'draft', plannedAt: d.plannedAt });
        act([d.id], null);
        setSelId(d.id);
        setLookOver(true);
      }));
    } catch (e) {
      anim?.cancel();
      act([d.id], null);
      failure(friendlyApiError(e));
    }
    void refresh();
  };

  const approveAll = () =>
    run(async () => {
      const list = approvable.map((i) => ({ draftId: i.draft.id, plannedAt: i.draft.plannedAt }));
      const ids = list.map((x) => x.draftId);
      act(ids, 'approved');
      setFlash({ ids, days: strip.filter((b) => b.items.some((i) => ids.includes(idOf(i)))).map((b) => b.key) });
      setLookOver(false);
      const r = await apiPost<{ approved: Approved[]; skipped: (Skipped & { draftId: string })[] }>('/api/plan/approve', { all: true });
      const trims = r.skipped.filter((s) => s.reason === 'too_long');
      const other = r.skipped.filter((s) => s.reason !== 'too_long');
      act(other.map((s) => s.draftId), null);
      const back = list.filter((x) => r.approved.some((a) => a.draftId === x.draftId));
      const undo = back.length ? () => unapprove(back) : undefined;
      if (other.length) failure(`${other.length} not approved. ${skipMessage(other[0])}`);
      else notice(`Approved ${r.approved.length}.${trims.length ? ` ${trims.length} need${trims.length > 1 ? '' : 's'} a trim first.` : ''}`, undo);
    });

  /** The buffer's drafts get proposed times across the week — still drafts to review. Undo puts them back. */
  const spread = () =>
    run(async () => {
      const r = await apiPost<{ placed: { draftId: string; previous: string | null }[]; left: number }>('/api/plan/spread', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      const n = r.placed.length;
      if (!n) return notice('No free slots left this week. Pick a time on each post instead.');
      notice(`Spread ${n} post${n > 1 ? 's' : ''} across the week. Still drafts to review.${r.left ? ` ${r.left} didn’t fit.` : ''}`, () => run(async () => {
        await Promise.all(r.placed.map((p) => apiPatch(`/api/drafts/${p.draftId}`, { plannedAt: p.previous })));
        notice('Moved back.');
      }));
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

  const saveBody = (it: CalItem, b: string) => {
    if (it.kind !== 'draft') return;
    const prev = it.draft.body;
    return run(async () => {
      await apiPatch(`/api/drafts/${it.draft.id}`, { body: b });
      notice('Caption saved.', () => run(async () => {
        await apiPatch(`/api/drafts/${it.draft.id}`, { body: prev });
        setEdit({ id: it.draft.id, body: prev });
        notice('Caption restored.');
      }));
    });
  };

  const postAction = (it: CalItem, a: PostAction) => {
    if (it.kind !== 'post') return;
    const rows = it.group.rows;
    if (a === 'unapprove') return unapprove([{ draftId: rows[0].draftId, plannedAt: it.at.getTime() > clock() + SOON_MS ? it.at.toISOString() : null }], rows[0].draftId);
    const later = it.at.getTime() > clock() + SOON_MS ? it.at : startOfHour(addHours(new Date(), 1));
    const each = (fn: (id: string) => Promise<unknown>) => Promise.all(rows.map((r) => fn(r.id)));
    return run(async () => {
      if (a === 'cancel') { await each((id) => apiDelete(`/api/schedule/${id}`)); notice('Canceled.', () => postAction({ ...it, group: { ...it.group, status: 'canceled', error: 'user_canceled' } }, 'restore')); }
      if (a === 'retry') { await each((id) => apiPatch(`/api/schedule/${id}`, { scheduledAt: addMinutes(new Date(), 5).toISOString() })); notice('Queued to retry in 5 minutes.'); }
      if (a === 'restore') { await each((id) => apiPatch(`/api/schedule/${id}`, { scheduledAt: later.toISOString() })); notice(`Restored for ${fmtSlot(later)}.`); }
    });
  };

  const [dragging, setDragging] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const drop = (b: Bucket, key: string) => {
    const it = items.find((i) => i.key === key);
    if (it && b.day) reschedule(it, moveToDay(it, b.day));
  };

  const unhealthy = now ? (accounts ?? []).filter((a) => !a.isStub && healthFor(a, now).tone === 'bad') : [];
  const risk = unhealthy.length ? firstAtRisk(items, unhealthy.map((a) => a.platform), now) : null;
  const noAccounts = accounts?.length === 0;
  const block = blocked ?? (plan?.counts.missing && !generating ? plan.blocked : null) ?? (noAccounts ? 'no_accounts' : null);
  const blockInfo = block ? BLOCKED[block] : undefined;
  const planN = Math.min(plan?.counts.missing ?? 0, 30);

  const range = today && `${format(today, isSameMonth(today, addDays(today, 6)) ? 'd' : 'd MMM')} – ${format(addDays(today, 6), 'd MMM')}`;
  const loading = !today || !plan || !schedApi.data;
  const mode: 'error' | 'loading' | 'empty' | 'filed' | 'review' =
    planApi.error ? 'error' : loading ? 'loading' : !items.length ? 'empty' : filed ? 'filed' : 'review';

  // A approve · S skip · E edit caption · ←/→ browse. Not while typing, with a modifier, or with a popover open.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keys.current = (e) => {
      if (mode !== 'review' || !sel || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('.when-pop, dialog[open]')) return;
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); void approve(sel); }
      else if (k === 's') { e.preventDefault(); void skip(sel); }
      else if (k === 'e' && capRef.current && !capRef.current.readOnly) { e.preventDefault(); capRef.current.focus(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- the decision bar: always there; what it says and enables follows the selected post ----
  const selTone = sel ? toneOf(sel) : null;
  const canAct = mode === 'review' && !!sel && selTone === 'review';
  let line: React.ReactNode;
  let lineTone: 'ok' | 'err' | '' = '';
  let side: React.ReactNode = null;
  if (mode === 'error') line = 'Couldn’t load your plan.';
  else if (mode === 'loading') line = 'Loading your week…';
  else if (mode === 'empty') line = generating ? 'Drafts appear above as Autopilot writes them.' : 'Nothing to review yet. Plan the week first.';
  else if (mode === 'filed') { line = 'All reviewed. Every approved post is scheduled.'; lineTone = 'ok'; }
  else if (sel && selTone === 'review' && sel.kind === 'draft') {
    const d = sel.draft;
    if (over.length) { line = `Can’t approve: too long for ${plats(over)}. Trim the caption first.`; lineTone = 'err'; }
    else if (d.rendering) line = 'Approve now: it posts when the video lands.';
    else if (!sel.at || d.overdue) line = `Approving gives it the next free slot on ${plats(itemPlatforms(sel)) || 'its platforms'}.`;
    else line = `Approving schedules it for ${fmtSlot(sel.at)} on ${plats(itemPlatforms(sel)) || 'its platforms'}.`;
  } else if (sel && selTone === 'waiting') { line = 'Approved · posts when the video lands.'; lineTone = 'ok'; }
  else if (sel?.kind === 'post') {
    const g = sel.group;
    if (selTone === 'pending') {
      line = `Approved · scheduled for ${fmtSlot(sel.at)}`; lineTone = 'ok';
      side = <>
        <button type="button" className="btn sm" disabled={busy} onClick={() => postAction(sel, 'unapprove')}>Back to review</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => postAction(sel, 'cancel')}>Cancel post</button>
      </>;
    } else if (selTone === 'publishing') line = 'Publishing now.';
    else if (selTone === 'published') {
      line = `Posted · ${fmtSlot(sel.at)}`; lineTone = 'ok';
      side = g.url ? <a className="btn sm" href={g.url} target="_blank" rel="noreferrer">View post <Icon name="arrow_up_right" size={12} /></a> : null;
    } else if (g.accountGone) {
      line = `The ${plats(g.platforms)} account is disconnected. Reconnect it and this post goes out.`; lineTone = 'err';
      side = <Link className="btn sm" href="/settings/connections">Reconnect</Link>;
    } else if (selTone === 'failed') {
      line = `Failed: ${g.error || 'no reason was recorded.'}`; lineTone = 'err';
      side = <button type="button" className="btn sm" disabled={busy} onClick={() => postAction(sel, 'retry')}>Retry</button>;
    } else {
      line = statusLabel(sel);
      side = restorable(g) ? <button type="button" className="btn sm" disabled={busy} onClick={() => postAction(sel, 'restore')}>Restore</button> : null;
    }
  } else line = 'Pick a post to review it.';
  const whyNot = canAct ? undefined : mode === 'review' && sel ? 'Already decided: this post isn’t waiting for review' : 'Nothing to review';

  let main: React.ReactNode = null;
  if (mode === 'error') {
    main = <p className="home__alert" role="alert">Couldn’t load your plan. <button type="button" className="btn sm" onClick={() => refresh()}>Try again</button></p>;
  } else if (mode === 'loading') {
    main = <Skeleton />;
  } else if (mode === 'empty') {
    main = (
      <section className="home-card home-plan" aria-label="Plan this week">
        <span className="home-plan__spark"><Icon name="sparkle" size={20} /></span>
        <h2>Plan this week</h2>
        <p>Autopilot writes one topic a day for each of your platforms, in your voice. Nothing posts until you approve it.</p>
        <button type="button" className="btn primary home__cta" onClick={generate} disabled={busy || generating || !!blockInfo || !planN}>
          {generating ? 'Drafting…' : busy ? 'Starting…' : `Plan ${planN || ''} post${planN === 1 ? '' : 's'}`}
          <span className="home-cost">≈ {plan?.estimatedCredits ?? 0} cr</span>
        </button>
        {generating ? <span className="home-mono" role="status">{drafted} of {draftTotal} drafted · days fill in as each lands</span>
          : blockInfo ? <p className="home__note">{blockInfo.text} <Link href={blockInfo.href}>{blockInfo.cta} →</Link></p>
          : !planN ? <p className="home__note">You’re at your weekly target. Change it in <Link href="/autopilot">Autopilot</Link>.</p>
          : <span className="home-mono">{credits ? `Balance ${credits.balance.toLocaleString('en-US')} cr · ` : ''}takes about 2 minutes</span>}
      </section>
    );
  } else if (mode === 'filed') {
    const days = strip.filter((b) => b.day);
    const live = items.filter((i) => toneOf(i) !== 'canceled').length;
    main = (
      <section className="home-card home-filed" aria-label="Week filed">
        <span className="home-filed__tk"><Tick /></span>
        <h2>Your week is filed</h2>
        <span className="home-filed__slot tnum">{live} post{live === 1 ? '' : 's'} scheduled · {range}</span>
        <div className="home-filed__ledger">
          {days.map((b, k) => {
            const n = b.items.filter((i) => toneOf(i) !== 'canceled').length;
            return <div key={b.key} style={{ animationDelay: `${360 + k * 50}ms` }}><b>{format(b.day!, 'EEE d MMM')}</b><span className="tnum">{n ? `${n} post${n > 1 ? 's' : ''}` : '—'}</span></div>;
          })}
        </div>
        <p>Nothing else needs you this week. If a post fails or an account drops, it shows up here with a fix.</p>
        <div className="home-row">
          <button type="button" className="btn" onClick={() => { setLookOver(true); if (order[0]) select(order[0], 0); }}>Look over a post</button>
          <Link className="btn primary" href="/compose"><Icon name="plus" size={13} />New post</Link>
        </div>
      </section>
    );
  } else if (sel && plan) {
    main = (
      <ReviewPanel
        key={idOf(sel)}
        item={sel}
        index={selIndex}
        total={order.length}
        dir={dir}
        now={now}
        today={today!}
        limits={plan.limits}
        body={body}
        over={over}
        developed={developed.includes(idOf(sel))}
        capRef={capRef}
        authorFor={(p) => accounts?.find((a) => a.platform === p)}
        onBody={(b) => setEdit({ id: idOf(sel), body: b })}
        onSaveBody={(b) => saveBody(sel, b)}
        onStep={step}
        onReschedule={(at) => reschedule(sel, at)}
      />
    );
  }

  return (
    <div className="home">
      <header className="home__head">
        <h1 className="home__title">This week <span className="home__range tnum">{range}</span></h1>
        <div className="home__meter" role="status">
          {generating && items.length > 0
            ? <span className="home-mono">Drafting · {drafted} of {draftTotal} drafted</span>
            : <span className="tnum"><b>{count}</b> of {total} reviewed</span>}
          <span className={`bar${total && done === total ? ' is-done' : ''}`}><i style={{ transform: `scaleX(${total ? done / total : 0})` }} /></span>
        </div>
        <button type="button" className="btn home__all" onClick={approveAll} disabled={busy || !approvable.length}
          title={approvable.length ? undefined : needTrim ? 'The rest need a trim first' : 'Nothing left to approve'}>
          Approve all <span className="home-cost">{approvable.length}</span>
        </button>
      </header>

      {unhealthy.length > 0 && (
        <p className="home__alert" role="alert">
          <Icon name="alert" size={14} />
          <span>
            {plats(unhealthy.map((a) => a.platform))} need{unhealthy.length > 1 ? '' : 's'} reconnecting
            {risk?.at ? ` before ${format(risk.at, 'EEE h:mm a')} can post.` : ' before it can post.'}
          </span>
          <Link className="btn sm" href="/settings/connections">Reconnect{unhealthy.length === 1 ? ` ${plats(unhealthy.map((a) => a.platform))}` : ''}</Link>
        </p>
      )}
      {schedApi.error && (
        <p className="home__alert" role="alert">Couldn’t load scheduled posts. <button type="button" className="btn sm" onClick={() => refresh()}>Try again</button></p>
      )}

      {mode !== 'error' && mode !== 'loading' && (
        <section className="home-card home__week" aria-label="This week">
          <div className={`strip${dragging ? ' is-dragging' : ''}`} role="tablist" aria-label="Days">
            {strip.map((b) => (
              <DayTile
                key={b.key}
                b={b}
                today={today!}
                on={mode !== 'empty' && b.key === shownKey}
                over={overDay === b.key}
                generating={generating}
                landed={flash.days.includes(b.key)}
                dev={devDays.includes(b.key)}
                onClick={() => pickDay(b)}
                drop={b.day ? {
                  onDragOver: (e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverDay(b.key); } },
                  onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverDay(null); },
                  onDrop: (e) => { e.preventDefault(); setOverDay(null); drop(b, e.dataTransfer.getData('text/x-cal')); },
                } : undefined}
              />
            ))}
          </div>
          {mode !== 'empty' && shown && (
            <div key={shown.key} className="dday">
              <div className="dday__h">
                <b>{shown.key === NO_TIME ? 'No time yet' : shown.key === LATER ? 'Later' : format(shown.day!, 'EEE d MMM')}</b>
                <span className="home__note">
                  {shown.key === NO_TIME ? `${shown.items.length} post${shown.items.length === 1 ? '' : 's'} whose time passed or was never set`
                    : shown.items.length ? `${shown.items.length} post${shown.items.length === 1 ? '' : 's'}` : ''}
                </span>
                {shown.key === NO_TIME ? (
                  <button type="button" className="btn sm dday__act" onClick={spread} disabled={busy || !shown.items.some((i) => i.kind === 'draft' && movable(i))}>
                    <Icon name="calendar" size={12} />Spread across the week
                  </button>
                ) : (
                  <Link className="btn sm dday__act" href={composeFor(shown.day)}><Icon name="plus" size={12} />New post{shown.day ? ` for ${format(shown.day, 'EEE')}` : ''}</Link>
                )}
              </div>
              {shown.items.length ? (
                <div className="dposts" role="list">
                  {shown.items.map((i) => (
                    <PostCard
                      key={i.key}
                      item={i}
                      bucket={shown}
                      on={!filed && i === sel}
                      just={flash.ids.includes(idOf(i))}
                      developed={developed.includes(idOf(i))}
                      over={i === sel ? over.length > 0 : i.kind === 'draft' && !i.draft.approved && i.draft.tooLong.length > 0}
                      dragged={dragging === i.key}
                      onClick={() => select(i)}
                      onDrag={(k) => { setDragging(k); if (!k) setOverDay(null); }}
                    />
                  ))}
                </div>
              ) : (
                <div className="dday__empty">
                  <p>
                    Nothing on {shown.day ? format(shown.day, 'EEE d MMM') : 'this day'}.
                    {plan ? ` Autopilot plans up to your weekly target of ${plan.counts.target} posts and you have ${plan.counts.target - plan.counts.missing}.` : ''}
                    {' '}Add one yourself, or move a post here with its time picker.
                  </p>
                  <div className="home-row">
                    <Link className="btn primary sm" href={composeFor(shown.day)}><Icon name="plus" size={12} />New post{shown.day ? ` for ${format(shown.day, 'EEE')}` : ''}</Link>
                    <button type="button" className="btn sm" onClick={generate} disabled={busy || generating || !planN || !!blockInfo}>
                      {generating ? 'Drafting…' : 'Plan more'} <span className="home-cost">{plan?.estimatedCredits ?? 0} cr</span>
                    </button>
                    {(!planN || blockInfo) && !generating && (
                      <span className="home__note">{blockInfo ? <>{blockInfo.text} <Link href={blockInfo.href}>{blockInfo.cta} →</Link></> : 'Plan more is off: you’re at your weekly target.'}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {main}

      <div className="home-bar">
        <div className="home-toast-wrap">
          {toast && <ToastBar key={toast.id} toast={toast} onClose={closeToast} />}
        </div>
        <p className={`home-bar__line${lineTone ? ` is-${lineTone}` : ''}`} role="status">
          {lineTone === 'ok' && <Tick />}
          <span>{line}</span>
          {side}
        </p>
        <span className="home-bar__keys" aria-hidden="true">
          <span><kbd>←</kbd><kbd>→</kbd> browse</span><span><kbd>E</kbd> edit</span><span><kbd>A</kbd> approve</span><span><kbd>S</kbd> skip</span>
        </span>
        <div className="home-bar__btns">
          <button type="button" className="btn home-bar__btn" disabled={!canAct} title={whyNot} onClick={() => sel && skip(sel)}>Skip <kbd>S</kbd></button>
          <button type="button" className="btn primary home-bar__btn" disabled={!canAct || over.length > 0} title={over.length ? 'Too long: trim the caption first' : whyNot}
            onClick={() => sel && approve(sel)}>
            <Icon name="check" size={13} />Approve <kbd>A</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

type DropProps = Pick<React.HTMLAttributes<HTMLButtonElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;

function DayTile({ b, today, on, over, generating, landed, dev, onClick, drop }: {
  b: Bucket; today: Date; on: boolean; over: boolean; generating: boolean; landed: boolean; dev: boolean; onClick: () => void; drop?: DropProps;
}) {
  const n = b.items.length;
  const doneN = n - b.toReview;
  const isToday = b.day && dayKey(b.day) === dayKey(today);
  const cls = ['dtile', on && 'is-on', isToday && 'is-today', over && 'is-over', drop && 'is-drop', !b.day && 'is-edge', landed && 'is-landed', dev && 'is-dev'].filter(Boolean).join(' ');
  return (
    <button type="button" role="tab" aria-selected={on} className={cls} data-day={b.key} onClick={onClick} {...drop}>
      <span className="dtile__h">
        {b.key === NO_TIME ? <><Icon name="clock" size={12} /><b>No time yet</b></> : b.key === LATER ? <b>Later</b>
          : <><b>{isToday ? 'Today' : format(b.day!, 'EEE')}</b><span className="tnum">{format(b.day!, 'd')}</span></>}
      </span>
      <span className="dtile__tp">{b.topic ?? ' '}</span>
      <span className={`dtile__sum tnum${n && !b.toReview ? ' is-ok' : ''}`}>
        {n ? <>{n} post{n > 1 ? 's' : ''} · {b.toReview ? <em>{b.toReview} to review</em> : 'all set'}</> : generating ? 'Drafting…' : 'No posts'}
      </span>
      <span className="mb"><i className={n && !b.toReview ? 'is-ok' : ''} style={{ transform: `scaleX(${n ? doneN / n : 0})` }} /></span>
    </button>
  );
}

function PostCard({ item, bucket, on, just, developed, over, dragged, onClick, onDrag }: {
  item: CalItem; bucket: Bucket; on: boolean; just: boolean; developed: boolean; over: boolean; dragged: boolean; onClick: () => void; onDrag: (key: string | null) => void;
}) {
  const tone = toneOf(item);
  const can = movable(item);
  const when = !item.at ? 'No time'
    : bucket.key === NO_TIME ? 'Time passed'
    : bucket.key === LATER ? format(item.at, 'EEE d · h:mm a')
    : format(item.at, 'h:mm a');
  const rendering = item.kind === 'draft' && item.draft.rendering && !itemMedia(item);
  const topic = item.kind === 'draft' ? item.draft.title?.trim() : null;
  return (
    <button
      type="button"
      role="listitem"
      data-post={idOf(item)}
      className={`pcard pcard--${tone}${on ? ' is-on' : ''}${just ? ' is-just' : ''}${dragged ? ' is-dragged' : ''}`}
      aria-pressed={on}
      aria-label={`${KIND_LABEL[kindOf(item)]} at ${when}, ${over ? 'too long' : statusLabel(item)}`}
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
      <Thumb item={item} rendering={rendering} developed={developed} />
      <span className="pcard__main">
        <span className="pcard__tm tnum">{when}</span>
        <span className="pcard__lb">{rendering ? 'Video · rendering' : KIND_LABEL[kindOf(item)]}{topic ? ` · ${topic}` : ''}</span>
        <Glyphs platforms={itemPlatforms(item)} />
      </span>
      <span className="pcard__st" title={over ? 'Too long' : statusLabel(item)}>
        {tone === 'review' ? <i className={`rdot${over ? ' is-err' : ''}`} /> : tone === 'failed' ? <i className="rdot is-err" /> : tone === 'canceled' ? <i className="skp" /> : <Tick />}
      </span>
    </button>
  );
}

/** Card thumbnail: the image, a video's poster (else a representative frame), ruled lines for a text post, a sheen while rendering. */
function Thumb({ item, rendering, developed }: { item: CalItem; rendering: boolean; developed: boolean }) {
  const m = itemMedia(item);
  const k = kindOf(item);
  return (
    <span className={`thumb thumb--${k}${rendering ? ' is-rendering' : ''}${developed ? ' develop' : ''}`} aria-hidden="true">
      {m && isVideo(m) && !m.posterUrl ? <VideoThumb url={m.url} />
        : m ? <ThumbImg src={m.posterUrl ?? m.url} alt="" size={48} /> : null}
      {k === 'video' && !rendering && <span className="thumb__play" />}
    </span>
  );
}

/**
 * Video frame for a card. A strip can hold 30+ videos; mounting them all at once starves Chrome's
 * per-host media connections, so some sit at readyState 0/1 with their seek pending and paint blank.
 * Only load once the card nears the viewport, and re-run the (idempotent) seek on metadata, data and mount.
 */
function VideoThumb({ url }: { url: string }) {
  const [near, setNear] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <span ref={box} className="thumb__vid">
      {near && <video src={url} preload="metadata" muted playsInline onLoadedMetadata={seekToPoster} onLoadedData={seekToPoster}
        ref={(v) => { if (v && v.readyState >= 1) seekToPoster({ currentTarget: v }); }} />}
    </span>
  );
}

function Skeleton() {
  return (
    <>
      <section className="home-card home__week" aria-busy="true" aria-label="Loading">
        <div className="strip">{Array.from({ length: 7 }, (_, i) => <div key={i} className="sk sk--tile" />)}</div>
        <div className="dposts">{Array.from({ length: 3 }, (_, i) => <div key={i} className="sk sk--card" />)}</div>
      </section>
      <div className="hr">
        <div className="hr-ed"><div className="sk" style={{ height: 12, width: '40%' }} /><div className="sk" style={{ height: 132 }} /><div className="sk" style={{ height: 30, width: 200 }} /></div>
        <div className="hr-pv"><div className="sk" style={{ height: 240 }} /></div>
      </div>
    </>
  );
}

/** Result of an action, right above the bar that caused it, with Undo where there is one. Errors linger longer. */
function ToastBar({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, toast.error ? 8000 : toast.undo ? 6000 : 3000);
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
