'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Pglyph } from './icons';
import { apiPost, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../lib/ui/platforms';
import { healthFor, type HealthAccount } from '../lib/ui/health';
import type { PlanView } from '../lib/agent/plan';
import type { Platform } from '../lib/db/schema';
import { ReviewCard, fmtTime, skipMessage } from './plan/review-card';

type Account = HealthAccount & { id: string; platform: Platform };
type Horizon = 7 | 30;

/** generate's 409 reasons (lib/agent/run.ts) → the one place that fixes each. */
const BLOCKED: Record<string, { text: string; href: string; cta: string }> = {
  no_accounts: { text: 'Connect an account so there is somewhere to post.', href: '/settings/connections', cta: 'Connect an account' },
  no_allowed_platforms: { text: 'Turn on at least one account for autopilot.', href: '/autopilot', cta: 'Open Autopilot' },
  no_niches: { text: 'Pick what to write about first.', href: '/autopilot', cta: 'Pick topics' },
  no_settings: { text: 'Set up autopilot first.', href: '/autopilot', cta: 'Set up Autopilot' },
  credit_cap: { text: 'This week’s credit cap is reached.', href: '/autopilot', cta: 'Raise the cap' },
  insufficient_credits: { text: 'You’re out of credits.', href: '/settings/plan', cta: 'Top up' },
};

const dayKey = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) : 'No time set';
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

export default function Dashboard() {
  const [horizon, setHorizon] = useState<Horizon | null>(null);
  const url = `/api/plan${horizon ? `?days=${horizon}` : ''}`;
  // While a plan run drafts, poll; otherwise sit still.
  const { data: plan, error, mutate } = useApi<PlanView>(url, {
    refreshInterval: (d) => ((d as PlanView | undefined)?.generating ? 4000 : 0),
  });
  const { data: accounts } = useApi<Account[]>('/api/accounts');

  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Health math needs a clock; read it after mount so render stays pure.
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);
  const unhealthy = now ? (accounts ?? []).filter((a) => !a.isStub && healthFor(a, now).tone === 'bad') : [];

  const days: Horizon = horizon ?? (plan?.horizonDays === 30 ? 30 : 7);
  const period = days === 30 ? 'month' : 'week';
  const ready = plan?.review.filter((r) => !r.approved) ?? [];
  const approvable = ready.filter((r) => !r.tooLong.length);
  const block = blocked ?? (accounts && accounts.length === 0 ? 'no_accounts' : null) ?? (plan?.counts.missing && !plan.generating ? plan.blocked : null);

  const groups = useMemo(() => {
    const m = new Map<string, PlanView['review']>();
    for (const r of plan?.review ?? []) m.set(dayKey(r.plannedAt), [...(m.get(dayKey(r.plannedAt)) ?? []), r]);
    return [...m];
  }, [plan]);
  const scheduled = useMemo(() => {
    const m = new Map<string, { at: string; text: string; platforms: Platform[] }>();
    for (const p of plan?.scheduled ?? []) {
      const k = p.draftId ?? p.id;
      const row = m.get(k) ?? { at: p.scheduledAt, text: p.text.split('\n')[0], platforms: [] };
      row.platforms.push(p.platform);
      m.set(k, row);
    }
    return [...m.values()];
  }, [plan]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setNotice(friendlyApiError(e));
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
      if (r.skipped.length) setNotice(`${r.skipped.length} not approved. ${skipMessage(r.skipped[0])}`);
    });
  const startReview = () => {
    setReviewing(true);
    document.getElementById('review')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // The one action, by state.
  let status = '';
  let action: ReactNode = null;
  if (plan) {
    const planned = plan.counts.target - plan.counts.missing;
    status = plan.counts.target
      ? `${planned} of ${plan.counts.target} posts planned`
      : `${plan.counts.scheduled} posts scheduled`;
    if (plan.counts.review) status += ` · ${plan.counts.review} need${plan.counts.review === 1 ? 's' : ''} your review`;

    if (block && BLOCKED[block]) {
      status = BLOCKED[block].text;
      action = <Link className="btn accent" href={BLOCKED[block].href}>{BLOCKED[block].cta}</Link>;
    } else if (plan.generating) {
      action = <span className="session__progress" role="status">Drafting {drafting ?? plan.counts.missing} posts…</span>;
    } else if (plan.counts.missing > 0) {
      action = <button className="btn accent" onClick={generate} disabled={busy}>{busy ? 'Starting…' : `Plan next ${period}${plan.estimatedCredits ? ` · ≈${plan.estimatedCredits} credits` : ''}`}</button>;
    } else if (ready.length && !reviewing) {
      action = <button className="btn accent" onClick={startReview}>Review {ready.length} post{ready.length === 1 ? '' : 's'}</button>;
    } else if (approvable.length) {
      action = <button className="btn accent" onClick={approveAll} disabled={busy}>{busy ? 'Approving…' : `Approve all ${approvable.length}`}</button>;
    } else if (!ready.length) {
      action = <span className="session__done">You’re set until {fmtDate(plan.to)}</span>;
    }
  }

  return (
    <div className="session">
      <header className="page-header session__head">
        <div>
          <h1>Next {days} days</h1>
          <p className="page-header__sub">{error ? 'Couldn’t load your plan.' : plan ? status : 'Loading…'}</p>
        </div>
        <div className="page-header__actions">
          <div className="mode-switch" role="group" aria-label="Planning period">
            {([7, 30] as const).map((d) => (
              <button key={d} className={`opt${days === d ? ' active' : ''}`} aria-pressed={days === d} onClick={() => setHorizon(d)}>
                {d === 7 ? 'Week' : 'Month'}
              </button>
            ))}
          </div>
          {error ? <button className="btn" onClick={() => mutate()}>Try again</button> : action}
        </div>
      </header>

      {unhealthy.length > 0 && (
        <p className="session__alert" role="alert">
          {unhealthy.length === 1 ? '1 account needs' : `${unhealthy.length} accounts need`} reconnecting before it can post.{' '}
          <Link href="/settings/connections">Reconnect</Link>
        </p>
      )}
      {notice && <p className="session__alert" role="alert">{notice}</p>}

      {plan && plan.review.length > 0 && (
        <section id="review" className="session__section" aria-label="To review">
          {groups.map(([day, items]) => (
            <div key={day} className="stack">
              <h2 className="session__day">{day}</h2>
              {items.map((r) => (
                <ReviewCard key={r.id} item={r} limits={plan.limits} onChange={() => mutate()} />
              ))}
            </div>
          ))}
        </section>
      )}

      {plan && (
        <section className="session__section" aria-labelledby="scheduled-h">
          <div className="session__section-head">
            <h2 id="scheduled-h" className="session__day">Scheduled</h2>
            <Link className="btn sm ghost" href="/calendar">Open calendar</Link>
          </div>
          {scheduled.length ? (
            <ul className="sched">
              {scheduled.map((s, i) => (
                <li key={i} className="sched__row">
                  <span className="sched__time tnum">{fmtDate(s.at)} · {fmtTime(s.at)}</span>
                  <span className="row">{s.platforms.map((p) => <Pglyph key={p} p={PLATFORM_TO_SHORT[p]} />)}</span>
                  <span className="sched__text">{s.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing scheduled for the next {days} days yet.</p>
          )}
        </section>
      )}
    </div>
  );
}
