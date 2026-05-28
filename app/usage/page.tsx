'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Sidebar, Topbar } from '../../components/shell';
import { Icon } from '../../components/icons';
import { useApi } from '../../lib/ui/fetcher';
import type { CreditsPayload } from '../../components/credits';

type Page = 'dashboard' | 'compose' | 'agent' | 'calendar' | 'connections' | 'onboarding';

const TIER_LABEL = { starter: 'Starter · $30/mo', pro: 'Pro · $80/mo', business: 'Business · $299/mo' };

export default function UsagePage() {
  const { data, isLoading } = useApi<CreditsPayload>('/api/credits', { refreshInterval: 30_000 });
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const balance = data?.balance ?? 0;
  const allocation = data?.monthlyAllocation ?? 0;
  const pct = allocation > 0 ? Math.min(100, Math.round((balance / allocation) * 100)) : 0;
  const tier = data?.tier ?? 'starter';
  const cycleStart = data?.creditCycleStart ? new Date(data.creditCycleStart) : null;
  const nextReset = cycleStart ? new Date(cycleStart.getTime() + 30 * 24 * 60 * 60 * 1000) : null;
  const daysLeft = nextReset ? Math.max(0, Math.ceil((nextReset.getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : null;

  const used30d = (data?.ledger ?? []).reduce((sum, row) => row.credits < 0 ? sum + Math.abs(row.credits) : sum, 0);

  return (
    <div className="app">
      <Sidebar
        page={'dashboard' as Page}
        onNav={() => {}}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        <Topbar
          crumbs={['Sociafy', 'Account', 'Usage']}
          onMenuClick={() => setSidebarOpen(true)}
        >
          <Link href="/dashboard" className="btn ghost">
            <Icon name="home" size={13} /> Dashboard
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
                  <Icon name="bolt" size={10} /> {TIER_LABEL[tier]}
                </span>
                <h3>Credits remaining</h3>
                <div className="num">{balance.toLocaleString()}</div>
                <div className="sub">
                  of {allocation.toLocaleString()} this cycle
                  {daysLeft !== null && <> · resets in {daysLeft}d</>}
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
                <h3>Used (last 50 actions)</h3>
                <div className="num">{used30d.toLocaleString()}</div>
                <div className="sub">
                  {data?.ledger?.length ? `${data.ledger.length} ledger entries shown` : 'No activity yet — credits will appear here as you generate.'}
                </div>
                <div style={{ marginTop: 20, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.55 }}>
                  Text = 1 cr · Image (medium) = 4 cr · 720p reel (8s) = 180 cr · 1080p hero (15s) = 835 cr. Failed generations refund automatically.
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
