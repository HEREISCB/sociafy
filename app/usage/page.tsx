'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sidebar, Topbar } from '../../components/shell';
import { Icon } from '../../components/icons';
import { useApi } from '../../lib/ui/fetcher';
import type { CreditsPayload } from '../../components/credits';
import { tierPriceView, type Currency } from '../../lib/billing/pricing';
import { CREDIT_PRICES } from '../../lib/credits/pricing';

type Page = 'dashboard' | 'compose' | 'agent' | 'calendar' | 'connections' | 'onboarding';

export default function UsagePage() {
  const router = useRouter();
  const { data, isLoading } = useApi<CreditsPayload>('/api/credits', { refreshInterval: 30_000 });
  // /billing owns currency detection; reusing its payload keeps the two pages
  // from quoting different prices. INR until it loads — that is what we charge.
  const { data: billing } = useApi<{ currency: Currency }>('/api/billing');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Ticking "now" so daysLeft stays pure during render.
  const [now, setNow] = useState<number>(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const balance = data?.balance ?? 0;
  const allocation = data?.monthlyAllocation ?? 0;
  const pct = allocation > 0 ? Math.min(100, Math.round((balance / allocation) * 100)) : 0;
  const tier = data?.tier ?? 'starter';
  // Was a hardcoded USD table ($30/$80/$299) nobody is ever charged.
  const tierLabel = `${tier.charAt(0).toUpperCase() + tier.slice(1)} · `
    + `${tierPriceView(billing?.currency ?? 'INR', tier).display}/mo`;
  const cycleStart = data?.creditCycleStart ? new Date(data.creditCycleStart) : null;
  const nextReset = cycleStart ? new Date(cycleStart.getTime() + 30 * 24 * 60 * 60 * 1000) : null;
  const daysLeft = nextReset && now > 0
    ? Math.max(0, Math.ceil((nextReset.getTime() - now) / (24 * 60 * 60 * 1000)))
    : null;

  // The ledger endpoint returns the 50 most recent rows; the card sums the
  // spends among exactly the rows rendered below it, so it must say that.
  const entryCount = data?.ledger?.length ?? 0;
  const spentRecently = (data?.ledger ?? []).reduce((sum, row) => row.credits < 0 ? sum + Math.abs(row.credits) : sum, 0);

  return (
    <div className="app">
      <Sidebar
        // Usage isn't one of the sidebar destinations, so no item is highlighted.
        page={'onboarding' as Page}
        onNav={(p) => router.push(p === 'dashboard' ? '/dashboard' : `/dashboard?tab=${p}`)}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        <Topbar
          crumbs={['Sociafy', 'Account', 'Usage']}
          onMenuClick={() => setSidebarOpen(true)}
        >
          <Link href="/dashboard" className="btn ghost">
            <Icon name="home" size={13} /> <span className="hide-mobile">Dashboard</span>
          </Link>
        </Topbar>
        <div className="page">
          <div className="page-head">
            <div>
              <h1>Usage & billing</h1>
              <div className="sub">Track how credits move through your account. Every generation, draft, and tool call lands here.</div>
            </div>
          </div>

          <div className="usage-page">
            <section className="usage-hero">
              <div className="usage-card">
                <span className="tier-pill">
                  <Icon name="bolt" size={10} /> {tierLabel}
                </span>
                <h3>Credits remaining</h3>
                <div className="num">{balance.toLocaleString()}</div>
                <div className="sub">
                  of {allocation.toLocaleString()} this cycle
                  {/* "resets in 0d" reads as a broken counter, not as "today". */}
                  {daysLeft !== null && (
                    <> · {daysLeft === 0 ? 'resets today' : daysLeft === 1 ? 'resets tomorrow' : `resets in ${daysLeft} days`}</>
                  )}
                </div>
                <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
                <div className="actions">
                  <Link href="/billing" className="btn primary">
                    <Icon name="bolt" size={12} /> Top up
                  </Link>
                  <Link href="/billing" className="btn">Compare plans</Link>
                </div>
              </div>

              <div className="usage-card">
                {/* Was "Used (last 50 actions)": it counts credits, not actions,
                    and 50 is the ledger fetch ceiling, not what is on screen —
                    so it read "3" directly above "5 ledger entries shown". */}
                <h3>Credits spent in recent activity</h3>
                <div className="num">{spentRecently.toLocaleString()}</div>
                <div className="sub">
                  {entryCount
                    ? `Across the ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} listed below`
                    : 'No activity yet — credits will appear here as you generate.'}
                </div>
                <div style={{ marginTop: 20, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.55 }}>
                  {/* Read off the charge table, not retyped — it advertised 4 cr per
                      image while every medium image was billed 6. */}
                  Text = {CREDIT_PRICES.text_post} cr · Image (medium) = {CREDIT_PRICES.image_medium_1024} cr
                  {' · '}720p reel (8s) = {CREDIT_PRICES.video_8s_720p_quality} cr
                  {' · '}1080p hero (15s) = {CREDIT_PRICES.video_15s_1080p_quality} cr. Failed generations refund automatically.
                </div>
              </div>
            </section>

            <section className="usage-ledger">
              <div className="usage-ledger-head">
                <span>Activity</span>
                <span style={{ textAlign: 'right' }}>Credits</span>
                <span style={{ textAlign: 'right' }}>When</span>
              </div>
              {isLoading && (
                <div className="usage-ledger-empty">Loading ledger…</div>
              )}
              {!isLoading && (!data?.ledger || data.ledger.length === 0) && (
                <div className="usage-ledger-empty">
                  No credit activity yet. Generate an image, video, or post and your usage will appear here.
                </div>
              )}
              {data?.ledger?.map((row) => (
                <LedgerRow key={row.id} row={row} />
              ))}
            </section>

            {/* Keys moved to /developers so there is exactly one home for them.
                id="api-keys" stays here because older links (docs, 429 hints)
                still target /usage#api-keys. */}
            <div className="usage-card" id="api-keys" style={{ marginTop: 28, scrollMarginTop: 24 }}>
              <h3>API keys</h3>
              <div className="sub" style={{ marginTop: 6 }}>
                API keys, the quickstart, endpoint reference, prices and limits now live on{' '}
                <Link href="/developers">Developers</Link>.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const LedgerRow: React.FC<{ row: CreditsPayload['ledger'][number] }> = ({ row }) => {
  const meta = row.meta ?? {};
  const metaLine = [
    (meta as Record<string, unknown>).providerTaskId ? `task ${String((meta as Record<string, unknown>).providerTaskId).slice(0, 8)}…` : null,
    (meta as Record<string, unknown>).draftId ? `draft ${String((meta as Record<string, unknown>).draftId).slice(0, 8)}…` : null,
    (meta as Record<string, unknown>).reason ? String((meta as Record<string, unknown>).reason) : null,
    row.kind === 'signup_bonus' ? 'welcome bonus' : null,
    row.kind === 'refund' ? 'refund' : null,
  ].filter(Boolean).join(' · ');
  const sign = row.credits >= 0 ? 'pos' : 'neg';
  return (
    <div className="usage-ledger-row">
      <div className="lbl-col">
        <div className="lbl">{row.label}</div>
        {metaLine && <div className="meta-line">{metaLine}</div>}
      </div>
      <div className={`credits-col ${sign}`}>
        {row.credits > 0 ? '+' : ''}{row.credits.toLocaleString()}
      </div>
      <div className="date-col">{relTime(row.createdAt)}</div>
    </div>
  );
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
