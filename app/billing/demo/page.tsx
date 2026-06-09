'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sidebar, Topbar } from '../../../components/shell';
import { Icon } from '../../../components/icons';
import { apiPost, useApi } from '../../../lib/ui/fetcher';

type Page = 'dashboard' | 'compose' | 'agent' | 'calendar' | 'connections' | 'onboarding';

type CreditsPayload = {
  balance: number;
  tier: 'starter' | 'pro' | 'business';
  monthlyAllocation: number;
};

const PACKS = [
  { credits: 500, label: '500 credits', sub: 'Try a couple of images + a short reel' },
  { credits: 2_000, label: '2,000 credits', sub: 'A few reels and a batch of images' },
  { credits: 10_000, label: '10,000 credits', sub: 'A month of heavy testing' },
] as const;

export default function DemoBillingPage() {
  const { data, mutate } = useApi<CreditsPayload>('/api/credits');
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const grant = async (credits: number) => {
    setBusy(credits);
    setError(null);
    setToast(null);
    try {
      const r = await apiPost<{ granted: number; balance: number }>(
        '/api/billing/demo-grant',
        { credits },
      );
      setToast(`+${r.granted.toLocaleString()} credits. New balance: ${r.balance.toLocaleString()}.`);
      await mutate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('403') || msg.includes('demo_disabled')) {
        setError(
          'Demo grants are disabled on this server. Set DEMO_CREDITS_ENABLED=1 in .env and restart.',
        );
      } else {
        setError(`Grant failed: ${msg.slice(0, 200)}`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="app">
      <Sidebar
        // Demo isn't a sidebar destination — leave nothing highlighted.
        page={'onboarding' as Page}
        onNav={(p) => router.push(p === 'dashboard' ? '/dashboard' : `/dashboard?tab=${p}`)}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        <Topbar
          crumbs={['Sociafy', 'Account', 'Demo credits']}
          onMenuClick={() => setSidebarOpen(true)}
        >
          <Link href="/billing" className="btn ghost">
            <Icon name="bolt" size={13} /> <span className="hide-mobile">Real billing</span>
          </Link>
        </Topbar>
        <div className="page">
          <div className="page-head">
            <div>
              <h1>Demo credits</h1>
              <div className="sub">
                Auto-grant credits without going through Razorpay. For internal testing only —
                hidden behind <code style={{ fontSize: 12 }}>DEMO_CREDITS_ENABLED=1</code> on the server.
              </div>
            </div>
          </div>

          {toast && (
            <div
              style={{
                padding: '10px 14px',
                background: 'var(--accent-soft)',
                border: '1px solid oklch(0.86 0.08 70)',
                borderRadius: 10,
                marginBottom: 16,
                fontSize: 13,
                color: 'var(--accent-ink)',
              }}
            >
              {toast}
            </div>
          )}

          {error && (
            <div
              style={{
                padding: '10px 14px',
                background: '#fff5f5',
                border: '1px solid #f0bcbc',
                borderRadius: 10,
                marginBottom: 16,
                fontSize: 13,
                color: '#7a2626',
              }}
            >
              {error}
            </div>
          )}

          <section
            style={{
              padding: 16,
              border: '1px solid var(--border)',
              borderRadius: 12,
              marginBottom: 20,
              background: 'var(--surface)',
            }}
          >
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 4 }}>
              Current balance
            </div>
            <div className="big-num mono" style={{ fontSize: 32 }}>
              {data?.balance?.toLocaleString() ?? '—'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              credits available
            </div>
          </section>

          <section style={{ display: 'grid', gap: 12 }}>
            {PACKS.map((pack) => (
              <button
                key={pack.credits}
                className="btn primary"
                onClick={() => grant(pack.credits)}
                disabled={busy !== null}
                style={{
                  justifyContent: 'space-between',
                  padding: '14px 18px',
                  fontSize: 14,
                  height: 'auto',
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <span>{pack.label}</span>
                  <span style={{ fontSize: 11, opacity: 0.85, fontWeight: 400 }}>{pack.sub}</span>
                </span>
                <span className="mono" style={{ fontSize: 13 }}>
                  {busy === pack.credits ? 'Granting…' : 'Grant'}
                </span>
              </button>
            ))}
          </section>

          <section
            style={{
              marginTop: 24,
              padding: 14,
              border: '1px dashed var(--border)',
              borderRadius: 10,
              fontSize: 12,
              color: 'var(--muted)',
              lineHeight: 1.55,
            }}
          >
            <strong style={{ color: 'var(--ink)' }}>Reminder:</strong> this page does not collect
            payment. Credits are added directly via an admin grant ledger entry and will appear in
            your usage history with the source <code>demo_grant</code>. Disable the endpoint by
            unsetting <code>DEMO_CREDITS_ENABLED</code> before sharing the build with real users.
          </section>
        </div>
      </div>
    </div>
  );
}
