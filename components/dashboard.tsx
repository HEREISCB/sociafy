'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSWRConfig } from 'swr';
import { addDays, addHours, addMinutes, format, isSameMonth, startOfDay, startOfHour } from 'date-fns';
import { Icon } from './icons';
import { apiDelete, apiPatch, apiPost, fetcher, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { cantPost, type HealthAccount } from '../lib/ui/health';
import { PLATFORM_LABELS } from '../lib/ui/platforms';
import type { PlanView } from '../lib/agent/plan';
import type { Platform } from '../lib/db/schema';
import {
  agenda, agendaOrder, calendarItems, dayKey, firstAtRisk, fmtSlot, groupRows, idOf, itemPlatforms, KIND_LABEL, kindOf, moveToDay, needsTime, nextToReview,
  overLimit, postable, progress, restorable, restorePatch, sameText, skipMessage, soonestToReview, statusLabel, textsOf, textsPatch, toReview, toneOf, weekFiled,
  type CalItem, type ScheduledRow, type Skipped, type TextsPatch,
} from './calendar/model';
import { ReviewPanel, Tick, slotLabel, type Author, type PostAction } from './calendar/review';
import { Agenda, type DropProps } from './calendar/agenda';
import { Button, Empty, PinBar, Skeleton as Skel, useToast } from './ui';

type Account = HealthAccount & Author & { id: string; platform: Platform };
type Approved = { draftId: string; scheduledAt: string | null; platforms: Platform[]; reslotted: boolean; rendering?: true };
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
const label = (p: Platform) => PLATFORM_LABELS[p] ?? p;
const plats = (ps: Platform[]) => ps.map(label).join(', ');
const isPhone = () => window.matchMedia('(max-width: 900px)').matches;
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

type DraftItem = Extract<CalItem, { kind: 'draft' }>;
/** Text typed into the post, not saved yet: what each target platform would post. */
type Edit = { id: string; texts: Partial<Record<Platform, string>> };

export default function Dashboard() {
  const now = useNow(60_000);
  const today = useMemo(() => (now ? startOfDay(new Date(now)) : null), [now]);
  const params = useSearchParams();
  /** Phone only: ?post=<id> is the review screen (pushState, so the back gesture returns to the list). */
  const urlPost = params.get('post');

  const planKey = '/api/plan?days=7';
  // Poll while a plan run drafts (4 s) or a clip renders (10 s); otherwise sit still.
  const pollMs = (d?: PlanView | null) => (d?.generating ? 4000 : d?.counts.rendering ? 10_000 : 0);
  const planApi = useApi<PlanView>(planKey, { refreshInterval: (d) => pollMs(d as PlanView | undefined) });
  const plan = planApi.data;
  const schedKey = today ? `/api/schedule?from=${today.toISOString()}&to=${addDays(today, 7).toISOString()}` : null;
  const schedApi = useApi<ScheduledRow[]>(schedKey, { refreshInterval: pollMs(plan) });
  const { data: accounts, error: accountsError } = useApi<Account[]>('/api/accounts');
  /** Platforms with an account, healthy or not. null until known (or if it can't load: then nothing is narrowed). */
  const connected = useMemo(() => (accounts ? [...new Set(accounts.map((a) => a.platform))] : null), [accounts]);
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

  const toast = useToast();
  const notice = (text: string, undo?: () => void) => toast(text, { undo });
  const failure = (text: string) => toast(text, { tone: 'err' });

  /** Approves and skips show at once; the server catches up on refresh. */
  const [acted, setActed] = useState<Map<string, 'approved' | 'skipped'>>(new Map());
  const act = (ids: string[], v: 'approved' | 'skipped' | null) =>
    setActed((m) => { const n = new Map(m); for (const id of ids) { if (v) n.set(id, v); else n.delete(id); } return n; });
  /** Just approved: the row's tick draws. */
  const [just, setJust] = useState<string[]>([]);
  useEffect(() => {
    if (!just.length) return;
    const t = setTimeout(() => setJust([]), 1200);
    return () => clearTimeout(t);
  }, [just]);

  const items = useMemo(() => {
    const review = (plan?.review ?? [])
      .filter((d) => acted.get(d.id) !== 'skipped')
      .map((d) => (acted.get(d.id) === 'approved' ? { ...d, approved: true } : d));
    const all = calendarItems(review, groupRows(schedApi.data ?? []));
    // Only where each draft can go: a connected account that takes its kind of post.
    return connected ? all.map((i) => postable(i, connected)) : all;
  }, [plan, schedApi.data, acted, connected]);
  const ag = useMemo(() => (today ? agenda(items, today, now) : null), [items, today, now]);
  const order = useMemo(() => (ag ? agendaOrder(ag) : []), [ag]);
  const generating = !!plan?.generating;

  // A clip that was rendering has landed (the 10 s poll): its frame develops in.
  const [developed, setDeveloped] = useState<string[]>([]);
  const renderingIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!plan) return;
    const was = renderingIds.current;
    renderingIds.current = new Set(plan.review.filter((d) => d.rendering).map((d) => d.id));
    const landed = was ? plan.review.filter((d) => was.has(d.id) && !d.rendering && d.media.length) : [];
    if (!landed.length) return;
    setDeveloped(landed.map((d) => d.id));
    toast(`${landed[0].title?.trim() || 'Your'} video is ready.`);
    setTimeout(() => setDeveloped([]), 1200);
  }, [plan, toast]);

  const [selId, setSelId] = useState<string | null>(null);
  const [dir, setDir] = useState(0);
  /** "Look over a post" from the filed state (any explicit pick does the same). */
  const [lookOver, setLookOver] = useState(false);
  /** null until the user opens or closes it: then it follows whether the selection needs a time. */
  const [needOpen, setNeedOpen] = useState<boolean | null>(null);
  const pushed = useRef(false);
  const want = urlPost ?? selId;
  // Default: the soonest timed post still to review (it goes out first); the needs-a-time pile waits.
  const sel = order.find((i) => idOf(i) === want) ?? (ag ? soonestToReview(ag) : null);
  const selIndex = sel ? order.indexOf(sel) : -1;
  const filed = weekFiled(items) && !lookOver;

  // ---- the text, per platform ----
  const [edit, setEdit] = useState<Edit | null>(null);
  const editRef = useRef<Edit | null>(null);
  useEffect(() => { editRef.current = edit; }, [edit]);
  /** Same text everywhere: an explicit on/off per draft, else whether its platforms already share one text. */
  const [modes, setModes] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<{ id: string; p: Platform } | null>(null);
  const capRef = useRef<HTMLTextAreaElement>(null);
  const shownTexts = (it: CalItem) => (edit?.id === idOf(it) ? edit.texts : textsOf(it));
  const sameOf = (it: CalItem) => modes[idOf(it)] ?? sameText(textsOf(it), itemPlatforms(it));
  const overOf = (it: CalItem) => (toReview(it) ? overLimit(shownTexts(it), itemPlatforms(it), plan?.limits ?? {}) : []);

  const unhealthy = now ? (accounts ?? []).filter((a) => cantPost(a, now)) : [];
  const gone = [...new Set(unhealthy.map((a) => a.platform))];
  const liveOf = (it: CalItem) => itemPlatforms(it).filter((p) => !gone.includes(p));

  const show = (it: CalItem, d?: number) => {
    const id = idOf(it);
    setDir(d ?? (order.indexOf(it) >= selIndex ? 1 : -1));
    setSelId(id);
    setLookOver(true);
    if (ag?.need.includes(it)) setNeedOpen(true);
    // Desktop selection leaves the URL alone; the phone's review screen is a history entry.
    if (urlPost) window.history.replaceState(null, '', `?post=${id}`);
    else if (isPhone()) { pushed.current = true; window.history.pushState(null, '', `?post=${id}`); }
  };
  const step = (n: 1 | -1) => { if (order.length) show(order[(selIndex + n + order.length) % order.length], n); };
  const back = () => {
    if (pushed.current) { pushed.current = false; window.history.back(); }
    else window.history.replaceState(null, '', window.location.pathname);
  };
  const advance = (next: CalItem | null) => {
    if (next) setTimeout(() => show(next, 1), reduced() ? 0 : 340);
    else { setLookOver(false); if (urlPost) back(); } // nothing left: the week is filed
  };

  // Keep the selected row in view as ←/→ walk the agenda (desktop: the agenda scrolls on its own).
  const selKey = sel ? idOf(sel) : null;
  useEffect(() => {
    if (!selKey || isPhone()) return;
    document.querySelector(`.row[data-id="${CSS.escape(selKey)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selKey, needOpen]);

  const { done, total } = progress(items);
  const count = useCountUp(done);
  const approvable = items.filter((i): i is DraftItem => toReview(i) && i.kind === 'draft' && !overOf(i).length && liveOf(i).length > 0);
  const needTrim = items.filter((i) => toReview(i) && overOf(i).length).length;

  const [busy, setBusy] = useState(false);
  const [spreading, setSpreading] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
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

  /** PATCH a draft's text fields; Undo puts the previous ones back exactly (postText then gives what it gave before). */
  const patchText = async (d: DraftItem['draft'], patch: TextsPatch, msg: string) => {
    const prev = { body: d.body, perPlatformText: d.perPlatformText };
    await apiPatch(`/api/drafts/${d.id}`, patch);
    notice(msg, () => run(async () => {
      await apiPatch(`/api/drafts/${d.id}`, prev);
      setEdit(null);
      setModes((m) => { const n = { ...m }; delete n[d.id]; return n; });
      notice('Text restored.');
    }));
    await refresh();
  };

  /** Save what was typed (blur, tab switch, and before approving). Resolves false if the save failed. */
  const saving = useRef<Promise<boolean> | null>(null);
  const flush = async (it: CalItem): Promise<boolean> => {
    if (saving.current) await saving.current;
    const e = editRef.current;
    if (it.kind !== 'draft' || !e || e.id !== it.draft.id) return true;
    const ps = itemPlatforms(it);
    const changed = ps.filter((p) => e.texts[p] !== textsOf(it)[p]);
    if (!changed.length) { setEdit((c) => (c === e ? null : c)); return true; }
    const same = sameOf(it);
    const job = (async () => {
      try {
        await patchText(it.draft, textsPatch(it.draft, e.texts, ps, same), same && ps.length > 1 ? `Saved for ${plats(ps)}.` : `${plats(changed)} text saved.`);
        // The refetch has the server's texts (postText); drop the local copy unless more was typed meanwhile.
        setEdit((c) => (c === e ? null : c));
        return true;
      } catch (err) {
        failure(`Text not saved. ${friendlyApiError(err)}`);
        return false;
      }
    })();
    saving.current = job;
    try { return await job; } finally { saving.current = null; }
  };

  const type = (it: CalItem, p: Platform | undefined, v: string) => {
    const ps = itemPlatforms(it);
    const base = shownTexts(it);
    setEdit({ id: idOf(it), texts: sameOf(it) || !p ? Object.fromEntries(ps.map((q) => [q, v])) : { ...base, [p]: v } });
  };

  const toggleSame = (it: CalItem, p: Platform | undefined) => {
    if (it.kind !== 'draft' || !p) return;
    const d = it.draft;
    const ps = itemPlatforms(it);
    if (sameOf(it)) {
      // Nothing to write: each tab starts from the shared text; the first edit gives that platform its own.
      setModes((m) => ({ ...m, [d.id]: false }));
      return notice('Each platform can have its own text now.');
    }
    const texts = shownTexts(it);
    const shared = texts[p] ?? '';
    const others = ps.filter((q) => q !== p && texts[q] !== shared);
    setModes((m) => ({ ...m, [d.id]: true }));
    setEdit(null);
    return run(() => patchText(d, textsPatch(d, texts, [p, ...ps.filter((q) => q !== p)], true),
      others.length ? `${plats(others)} now post${others.length > 1 ? '' : 's'} the ${label(p)} text.` : 'Same text everywhere.'));
  };

  const restore = (it: CalItem) => {
    if (it.kind !== 'draft') return;
    const r = restorePatch(it.draft);
    if (!r) return;
    setEdit(null);
    setModes((m) => ({ ...m, [it.draft.id]: false }));
    return run(() => patchText(it.draft, r, 'Autopilot’s per-platform versions are back.'));
  };

  /** Undo for Approve / Approve all: back in review at the slots they had. */
  const unapprove = (list: { draftId: string; plannedAt: string | null }[], focus?: string) =>
    run(async () => {
      const r = await apiPost<Unapproved>('/api/plan/unapprove', { items: list });
      act(r.restored, null);
      if (focus && r.restored.includes(focus)) { setSelId(focus); setLookOver(true); }
      if (r.skipped.length) failure(`${r.skipped.length} already posting, so ${r.skipped.length > 1 ? 'they stay' : 'it stays'} scheduled.`);
      else notice(r.restored.length > 1 ? `${r.restored.length} posts are back in review.` : 'Back in review.');
    });

  const leftOut = (targets: Platform[], queued: Platform[]) => {
    const out = targets.filter((p) => !queued.includes(p));
    return out.length ? ` ${plats(out)} left out: reconnect to include ${out.length > 1 ? 'them' : 'it'}.` : '';
  };

  const approve = async (it: CalItem) => {
    if (it.kind !== 'draft' || !toReview(it) || overOf(it).length || !liveOf(it).length) return;
    const d = it.draft;
    // What's typed goes out: save it first (an unsaved edit would otherwise be dropped).
    if (!(await flush(it))) return;
    const next = nextToReview(order, d.id);
    act([d.id], 'approved');
    setJust([d.id]);
    advance(next);
    try {
      const r = await apiPost<{ approved: Approved[]; skipped: Skipped[] }>('/api/plan/approve', { draftIds: [d.id] });
      const a = r.approved[0];
      if (r.skipped[0] || !a) { act([d.id], null); failure(`Not approved. ${r.skipped[0] ? skipMessage(r.skipped[0]) : ''}`); }
      else {
        const when = a.rendering ? 'posts when the video lands' : a.scheduledAt ? fmtSlot(new Date(a.scheduledAt)) : 'next free slot';
        const missing = a.rendering ? leftOut(itemPlatforms(it), liveOf(it)) : leftOut(itemPlatforms(it), a.platforms ?? []);
        notice(`Approved · ${when}${a.reslotted ? ' (next free slot)' : ''}.${missing}`, () => unapprove([{ draftId: d.id, plannedAt: d.plannedAt }], d.id));
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
    const row = document.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(d.id)}"]`);
    const anim = row && !reduced() ? row.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-8px)' }], { duration: 200, easing: 'cubic-bezier(.2,0,0,1)', fill: 'forwards' }) : null;
    await anim?.finished.catch(() => {});
    act([d.id], 'skipped');
    setEdit((c) => (c?.id === d.id ? null : c));
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
      if (sel && !(await flush(sel))) return;
      const list = approvable.map((i) => ({ draftId: i.draft.id, plannedAt: i.draft.plannedAt }));
      const ids = list.map((x) => x.draftId);
      act(ids, 'approved');
      setJust(ids);
      setLookOver(false);
      const r = await apiPost<{ approved: Approved[]; skipped: (Skipped & { draftId: string })[] }>('/api/plan/approve', { all: true });
      const trims = r.skipped.filter((s) => s.reason === 'too_long');
      const other = r.skipped.filter((s) => s.reason !== 'too_long');
      act(other.map((s) => s.draftId), null);
      const back = list.filter((x) => r.approved.some((a) => a.draftId === x.draftId));
      const undo = back.length ? () => unapprove(back) : undefined;
      const without = gone.length && r.approved.some((a) => !a.rendering && items.some((i) => idOf(i) === a.draftId && itemPlatforms(i).some((p) => gone.includes(p))))
        ? ` ${plats(gone)} left out: reconnect to include it.` : '';
      if (other.length) failure(`${other.length} not approved. ${skipMessage(other[0])}`);
      else notice(`Approved ${r.approved.length}.${trims.length ? ` ${trims.length} need${trims.length > 1 ? '' : 's'} a trim first.` : ''}${without}`, undo);
    });

  /** The needs-a-time drafts get proposed times across the week, 3 a day at most — still drafts to review. Undo puts them back. */
  const spread = async () => {
    setSpreading(true);
    await run(async () => {
      const r = await apiPost<{ placed: { draftId: string; previous: string | null }[]; left: number }>('/api/plan/spread', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      const n = r.placed.length;
      setLeft(r.left || null);
      if (!n) { setLeft(r.left || null); return notice('No free slots left this week. Pick a time on each post instead.'); }
      notice(`Spread ${n} post${n > 1 ? 's' : ''} across the week. Still drafts to review.${r.left ? ` ${r.left} didn’t fit.` : ''}`, () => run(async () => {
        await Promise.all(r.placed.map((p) => apiPatch(`/api/drafts/${p.draftId}`, { plannedAt: p.previous })));
        setLeft(null);
        notice('Moved back.');
      }));
    });
    setSpreading(false);
  };

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
  const dropFor = (day: Date): DropProps => ({
    onDragOver: (e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverDay(dayKey(day)); } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverDay(null); },
    onDrop: (e) => {
      e.preventDefault();
      setOverDay(null);
      const it = items.find((i) => i.key === e.dataTransfer.getData('text/x-cal'));
      if (it) reschedule(it, moveToDay(it, day));
    },
  });

  const risk = gone.length ? firstAtRisk(items, gone, now) : null;
  const noAccounts = accounts?.length === 0;
  const block = blocked ?? (plan?.counts.missing && !generating ? plan.blocked : null) ?? (noAccounts ? 'no_accounts' : null);
  const blockInfo = block ? BLOCKED[block] : undefined;
  const planN = Math.min(plan?.counts.missing ?? 0, 30);

  const range = today && `${format(today, isSameMonth(today, addDays(today, 6)) ? 'd' : 'd MMM')}–${format(addDays(today, 6), 'd MMM')}`;
  const loading = !today || !plan || !schedApi.data || !ag || (accounts === undefined && !accountsError);
  const mode: 'error' | 'loading' | 'empty' | 'filed' | 'review' =
    planApi.error ? 'error' : loading ? 'loading' : !items.length ? 'empty' : filed ? 'filed' : 'review';
  const view = mode === 'filed' ? 'filed' : urlPost ? 'post' : 'list';

  // A approve · S skip · E edit the text · ←/→ browse. Not while typing, with a modifier, or with a popover open.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keys.current = (e) => {
      if (mode !== 'review' || !sel || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('.when-pop, dialog[open]')) return;
      if (isPhone() && !urlPost) return; // the phone's list screen: nothing is open to act on
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); void approve(sel); }
      else if (k === 's') { e.preventDefault(); void skip(sel); }
      else if (k === 'e' && capRef.current && !capRef.current.readOnly) {
        e.preventDefault();
        const t = capRef.current;
        t.focus();
        t.setSelectionRange(t.value.length, t.value.length);
      }
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
  const selOver = sel ? overOf(sel) : [];
  const selLive = sel ? liveOf(sel) : [];
  const selGone = sel ? itemPlatforms(sel).filter((p) => gone.includes(p)) : [];
  const canAct = mode === 'review' && !!sel && selTone === 'review';
  const goneNote = selGone.length && selLive.length ? ` ${plats(selGone)} skipped: reconnect to include ${selGone.length > 1 ? 'them' : 'it'}.` : '';
  let line: React.ReactNode;
  let lineTone: 'ok' | 'err' | 'warn' | '' = '';
  let side: React.ReactNode = null;
  if (mode === 'error') line = 'Couldn’t load your plan.';
  else if (mode === 'loading') line = 'Loading your week…';
  else if (mode === 'empty') line = generating ? 'Drafts appear here as Autopilot writes them.' : 'Nothing to review yet. Plan the week first.';
  else if (mode === 'filed') { line = 'All reviewed. Every approved post is scheduled.'; lineTone = 'ok'; }
  else if (sel && selTone === 'review' && sel.kind === 'draft') {
    const d = sel.draft;
    if (selOver.length) { line = `Can’t approve: too long for ${plats(selOver)}. Trim it first.`; lineTone = 'err'; }
    else if (!selLive.length && selGone.length) {
      line = <>Can’t approve: {plats(selGone)} need{selGone.length > 1 ? '' : 's'} reconnecting first. <Link href="/settings/connections">Reconnect</Link></>; lineTone = 'warn';
    }
    else if (!selLive.length) {
      line = <>Can’t approve: no connected account takes a {KIND_LABEL[kindOf(sel)].toLowerCase()} post. <Link href={`/compose?draft=${d.id}`}>Open in Compose</Link></>; lineTone = 'warn';
    }
    else if (d.rendering && !d.media.length) line = `Approve now: it posts when the video lands.${goneNote}`;
    else if (needsTime(sel, now)) line = `Approving gives it the next free slot${plan?.nextEmptySlot ? `, ≈ ${slotLabel(new Date(plan.nextEmptySlot), today!)}` : ''}, on ${plats(selLive)}.${goneNote}`;
    else line = `Approving schedules it for ${slotLabel(sel.at!, today!)} on ${plats(selLive)}.${goneNote}`;
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
      line = `The ${plats(g.platforms)} account is disconnected. Reconnect it, then retry this post.`; lineTone = 'err';
      side = <Link className="btn sm" href="/settings/connections">Reconnect</Link>;
    } else if (selTone === 'failed') {
      line = `Failed: ${g.error || 'no reason was recorded.'}`; lineTone = 'err';
      side = <button type="button" className="btn sm" disabled={busy} onClick={() => postAction(sel, 'retry')}>Retry</button>;
    } else {
      line = statusLabel(sel);
      side = restorable(g) ? <button type="button" className="btn sm" disabled={busy} onClick={() => postAction(sel, 'restore')}>Restore</button> : null;
    }
  } else line = 'Pick a post to review it.';
  const whyNot = canAct ? undefined : mode === 'review' && sel ? 'Already decided' : 'Nothing to review';
  const approveWhy = whyNot ?? (selOver.length ? 'Too long: trim it first' : !selLive.length ? (selGone.length ? 'Reconnect first' : 'No connected account takes it') : undefined);

  const needN = ag?.need.length ?? 0;
  const spreadWhy = !needN ? 'Nothing needs a time' : left && left >= needN ? 'No free slots left this week' : busy && !spreading ? 'Busy' : undefined;
  const reviewLeft = items.filter(toReview).length;
  const nextUp = ag ? soonestToReview(ag) : null;
  const selDraft = sel?.kind === 'draft' ? sel.draft : null;
  const selTab = sel && tab?.id === idOf(sel) ? tab.p : sel ? itemPlatforms(sel)[0] : undefined;
  const restoreDiffers = !!sel && !!selDraft?.machine && (() => {
    const r = restorePatch(selDraft)!;
    const back = textsOf({ ...sel, draft: { ...selDraft, ...r } } as DraftItem);
    return itemPlatforms(sel).some((p) => back[p] !== textsOf(sel)[p]);
  })();

  const allBtn = (
    <Button onClick={approveAll} disabled={busy || !approvable.length} size="sm"
      reason={busy ? undefined : approvable.length ? undefined : needTrim ? `${needTrim} need${needTrim > 1 ? '' : 's'} a trim first` : 'Nothing left to approve'}>
      Approve all <span className="count">{approvable.length}</span>
    </Button>
  );

  let pane: React.ReactNode = null;
  if (mode === 'filed') {
    const live = items.filter((i) => toneOf(i) !== 'canceled');
    const first = live.filter((i) => i.at && i.at.getTime() > now).sort((a, b) => a.at!.getTime() - b.at!.getTime())[0];
    pane = (
      <div className="filed" aria-label="Week filed">
        <span className="filed-tk"><Tick /></span>
        <h2>Your week is filed</h2>
        <p>All {live.length} post{live.length === 1 ? ' is' : 's are'} approved and scheduled · {range}. Nothing needs you until Autopilot drafts next week. If a post fails or an account drops, it shows up here with a fix.</p>
        {first?.at && <span className="filed-slot tnum">Next goes out {slotLabel(first.at, today!)}</span>}
        <div className="home-row">
          <button type="button" className="btn" onClick={() => { setLookOver(true); if (order[0]) show(order[0], 0); }}>Look over a post</button>
          <Link className="btn primary" href="/compose"><Icon name="plus" size={13} />New post</Link>
        </div>
      </div>
    );
  } else if (sel && plan && today) {
    pane = (
      <ReviewPanel
        key={idOf(sel)}
        item={sel}
        index={selIndex}
        total={order.length}
        dir={dir}
        now={now}
        today={today}
        limits={plan.limits}
        texts={shownTexts(sel)}
        same={sameOf(sel)}
        tab={selTab}
        gone={gone}
        nextSlot={plan.nextEmptySlot ? new Date(plan.nextEmptySlot) : null}
        developed={developed.includes(idOf(sel))}
        canRestore={restoreDiffers}
        capRef={capRef}
        authorFor={(p) => accounts?.find((a) => a.platform === p)}
        onTab={(p) => { void flush(sel); setTab({ id: idOf(sel), p }); }}
        onType={(v) => type(sel, selTab, v)}
        onDone={() => { void flush(sel); }}
        onSame={() => toggleSame(sel, selTab)}
        onRestore={() => restore(sel)}
        onStep={step}
        onBack={back}
        onReschedule={(at) => reschedule(sel, at)}
      />
    );
  }

  return (
    <div className="page-fill home" data-view={view}>
      <header className="home-head">
        <h1>This week</h1>
        {range && <span className="range tnum">{range}</span>}
        <span className="meter" role="status">
          {generating && items.length > 0
            ? <span className="home-mono">Drafting · {drafted} of {draftTotal} drafted</span>
            : <span className="tnum"><b>{count}</b>/{total} reviewed</span>}
          <span className={`bar${total && done === total ? ' is-done' : ''}`}><i style={{ transform: `scaleX(${total ? done / total : 0})` }} /></span>
        </span>
        {gone.length > 0 && (
          <Link className="chipwarn" href="/settings/connections"
            title={`${plats(gone)} need${gone.length > 1 ? '' : 's'} reconnecting${risk?.at ? ` before ${format(risk.at, 'EEE h:mm a')} can post there` : ''}. Until then, approving leaves ${gone.length > 1 ? 'them' : 'it'} out.`}>
            <Icon name="alert" size={12} /><u>Reconnect {plats(gone)}</u>
          </Link>
        )}
        <span className="home-all">{allBtn}</span>
      </header>
      {schedApi.error && (
        <p className="home-alert" role="alert">Couldn’t load scheduled posts. <button type="button" className="btn sm" onClick={() => refresh()}>Try again</button></p>
      )}

      {mode === 'error' ? (
        <p className="home-alert" role="alert">Couldn’t load your plan. <button type="button" className="btn sm" onClick={() => refresh()}>Try again</button></p>
      ) : mode === 'loading' ? (
        <div className="home-panes" aria-busy="true" aria-label="Loading">
          <div className="ag skel-pane">{Array.from({ length: 7 }, (_, i) => <Skel key={i} h={i ? 28 : 96} />)}</div>
          <div className="rv skel-pane"><Skel h={14} w="50%" /><Skel h={30} w={200} /><Skel h={220} /></div>
        </div>
      ) : mode === 'empty' ? (
        <section className="home-plan" aria-label="Plan this week">
          <Empty
            icon="sparkle"
            title="Plan this week"
            action={<>
              <Button variant="primary" size="lg" cost={plan?.estimatedCredits ?? 0} busy={busy || generating} onClick={generate}
                disabled={!!blockInfo || !planN} reason={blockInfo ? blockInfo.text : !planN ? 'You’re at your weekly target.' : undefined}>
                {generating ? 'Drafting…' : busy ? 'Starting…' : `Plan ${planN} post${planN === 1 ? '' : 's'}`}
              </Button>
              {generating ? <span className="home-mono" role="status">{drafted} of {draftTotal} drafted · they appear here as each lands</span>
                : blockInfo ? <Link className="home-link" href={blockInfo.href}>{blockInfo.cta} →</Link>
                : !planN ? <Link className="home-link" href="/autopilot">Change the target in Autopilot →</Link>
                : <span className="home-mono">{credits ? `Balance ${credits.balance.toLocaleString('en-US')} cr · ` : ''}takes about 2 minutes</span>}
            </>}
          >
            Autopilot writes one topic a day for each of your platforms, in your voice. {plan?.mode === 'auto' ? 'Each post goes out at its planned time; edit or skip it here before then.' : 'Nothing posts until you approve it.'}
          </Empty>
        </section>
      ) : (
        <div className="home-panes">
          <Agenda
            ag={ag!}
            today={today!}
            selId={filed ? null : selKey}
            needOpen={needOpen ?? (!!sel && ag!.need.includes(sel))}
            onNeedOpen={setNeedOpen}
            left={left}
            spreadBusy={spreading}
            spreadWhy={spreadWhy}
            onSpread={spread}
            onSelect={(it) => show(it)}
            just={just}
            tooLong={(it) => overOf(it).length > 0}
            composeFor={composeFor}
            dragging={dragging}
            onDrag={(k) => { setDragging(k); if (!k) setOverDay(null); }}
            overDay={overDay}
            dropFor={dropFor}
          />
          <section className="rv" aria-label={mode === 'filed' ? 'Week filed' : 'Review post'} key={mode === 'filed' ? 'filed' : selKey ?? 'none'}>
            {pane}
          </section>
        </div>
      )}

      {/* One bar. Phone list screen: Approve all and the way into review; otherwise Skip / Approve for the open post. */}
      <PinBar msg={<>
        <span className={`home-bar__line bar-post${lineTone ? ` is-${lineTone}` : ''}`}>{lineTone === 'ok' && <Tick />}<span>{line}</span>{side}</span>
        <span className="home-bar__line bar-list">{mode !== 'review' ? line : reviewLeft ? `${reviewLeft} to review · ${needN} need${needN === 1 ? 's' : ''} a time` : 'All reviewed. Every approved post is scheduled.'}</span>
      </>}>
        <span className="home-bar__keys" aria-hidden="true">
          <span><kbd>←</kbd><kbd>→</kbd> browse</span><span><kbd>E</kbd> edit</span>
        </span>
        <span className="bar-list">
          {allBtn}
          <button type="button" className="btn primary" disabled={mode !== 'review' || !nextUp || !toReview(nextUp)} title={nextUp && toReview(nextUp) ? undefined : 'Nothing left to review'}
            onClick={() => nextUp && show(nextUp, 1)}>
            Review next <Icon name="chevron_right" size={13} />
          </button>
        </span>
        <span className="bar-post">
          {/* The line says why Skip/Approve are off, so the buttons carry it as a title only. */}
          <button type="button" className="btn" disabled={!canAct} title={whyNot} onClick={() => sel && skip(sel)}>Skip <kbd>S</kbd></button>
          <button type="button" className="btn primary" disabled={!!approveWhy} title={approveWhy} onClick={() => sel && approve(sel)}>
            <Icon name="check" size={13} />Approve <kbd>A</kbd>
          </button>
        </span>
      </PinBar>
    </div>
  );
}
