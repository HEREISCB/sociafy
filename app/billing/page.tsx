'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Sidebar, Topbar } from '../../components/shell';
import { Icon } from '../../components/icons';
import { apiPost, useApi } from '../../lib/ui/fetcher';

type Page = 'dashboard' | 'compose' | 'agent' | 'calendar' | 'connections' | 'onboarding';

type BillingPayload = {
  currentTier: 'starter' | 'pro' | 'business';
  currentTierLabel: string;
  monthlyAllocation: number;
  balance: number;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  stripeCustomerId: string | null;
  hasActiveSubscription: boolean;
  billingConfigured: boolean;
  tiers: Array<{
    tier: 'starter' | 'pro' | 'business';
    label: string;
    priceMonthly: string;
    tagline: string;
    credits: number;
    isCurrent: boolean;
  }>;
};

const TIER_PERKS: Record<BillingPayload['currentTier'], string[]> = {
  starter: [
    '2,000 credits / month',
    'All 6 platforms',
    'Text, image & 720p video',
    'Manual posting + scheduling',
    'Email support',
  ],
  pro: [
    '6,000 credits / month',
    'All 6 platforms',
    'Autopilot — trend → draft → schedule',
    'Web research on captions',
    'Priority email support',
  ],
  business: [
    '25,000 credits / month',
    'All 6 platforms',
    '1080p hero clips included',
    'Autopilot with media generation',
    'Daily reel guarantee · onboarding call',
  ],
};

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="app"><div className="main"><div className="page">Loading…</div></div></div>}>
      <BillingPageInner />
    </Suspense>
  );
}

function BillingPageInner() {
  const { data, mutate } = useApi<BillingPayload>('/api/billing');
  const params = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Surface checkout return state from query params.
  useEffect(() => {
    const result = params.get('checkout');
    if (result === 'success') {
      setToast('Upgrade in progress — your credits will land within a few seconds.');
      // Re-fetch a few times because webhook may lag the redirect.
      const t1 = setTimeout(() => mutate(), 2000);
      const t2 = setTimeout(() => mutate(), 6000);
      const t3 = setTimeout(() => mutate(), 12000);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
    if (result === 'canceled') {
      setToast('Checkout canceled — no changes to your plan.');
    }
  }, [params, mutate]);

  const startCheckout = async (tier: 'starter' | 'pro' | 'business') => {
    setBusy(tier);
    try {
      const r = await apiPost<{ url: string }>('/api/billing/checkout', { tier });
      if (r.url) window.location.href = r.url;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('503')) {
        setToast('Billing isn\'t configured yet — Stripe keys missing in .env.local.');
      } else {
        setToast(`Checkout failed: ${msg.slice(0, 160)}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const cycleEnd = data?.subscriptionCurrentPeriodEnd ? new Date(data.subscriptionCurrentPeriodEnd) : null;
  const daysLeft = cycleEnd ? Math.max(0, Math.ceil((cycleEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : null;
  const pct = data && data.monthlyAllocation > 0
    ? Math.min(100, Math.round((data.balance / data.monthlyAllocation) * 100))
    : 0;

  return (
    <div className="app">
      <Sidebar page={'dashboard' as Page} onNav={() => {}} />
      <div className="main">
        <Topbar crumbs={['Sociafy', 'Account', 'Billing']}>
          <Link href="/dashboard" className="btn ghost">
            <Icon name="home" size={13} /> Dashboard
          </Link>
        </Topbar>
        <div className="page">
          <div className="page-head">
            <div>
              <h1>Billing & plan</h1>
              <div className="sub">Choose a plan, manage your subscription, or top up.</div>
            </div>
          </div>

          {toast && (
            <div style={{
              padding: '10px 14px',
              background: 'var(--accent-soft)',
              border: '1px solid oklch(0.86 0.08 70)',
              borderRadius: 10,
              marginBottom: 16,
              fontSize: 13,
              color: 'var(--accent-ink)',
            }}>{toast}</div>
          )}

          {data && !data.billingConfigured && (
            <div className="insufficient-credits-banner" style={{ background: '#fff8eb', borderColor: '#f0d68a' }}>
              <div className="icon" style={{ background: '#fbe9c8', color: '#6b4408' }}>!</div>
              <div className="copy">
                <strong>Stripe isn&apos;t configured yet.</strong>
                <span className="muted"> Add STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and the three STRIPE_PRICE_* env vars to .env.local. Until then, upgrades just show this page.</span>
              </div>
            </div>
          )}

          <div className="billing-page">
            <section className="billing-current">
              <div className="tier-pill">{data?.currentTierLabel ?? '—'}</div>
              <div className="billing-balance-row">
                <div>
                  <div className="big-num mono">{data?.balance?.toLocaleString() ?? '—'}</div>
                  <div className="muted-line">credits remaining of {data?.monthlyAllocation?.toLocaleString() ?? '—'}</div>
                </div>
                <div className="billing-meta mono">
                  {data?.hasActiveSubscription ? (
                    <>
                      <div>Status · {data.subscriptionStatus}</div>
                      {daysLeft !== null && <div>Renews in {daysLeft}d</div>}
                    </>
                  ) : (
                    <div>No active subscription</div>
                  )}
                </div>
              </div>
              <div className="billing-bar">
                <div className="fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="billing-perks">
                {data && TIER_PERKS[data.currentTier].map((perk) => (
                  <div key={perk} className="perk">
                    <Icon name="check" size={12} /> {perk}
                  </div>
                ))}
              </div>
            </section>

            <section className="billing-tiers">
              <h2 className="billing-section-head">Switch plan</h2>
              <div className="billing-tier-grid">
                {(data?.tiers ?? []).map((t) => (
                  <div key={t.tier} className={`billing-tier-card ${t.isCurrent ? 'current' : ''}`}>
                    {t.isCurrent && <div className="current-badge mono">Current</div>}
                    <div className="tier-label">{t.label}</div>
                    <div className="tier-price">{t.priceMonthly}<span className="per">/mo</span></div>
                    <div className="tier-tagline">{t.tagline}</div>
                    <ul className="tier-perks">
                      {TIER_PERKS[t.tier].map((perk) => (
                        <li key={perk}>{perk}</li>
                      ))}
                    </ul>
                    {t.isCurrent ? (
                      <button className="btn" disabled style={{ width: '100%', justifyContent: 'center' }}>
                        <Icon name="check" size={12} /> Current plan
                      </button>
                    ) : (
                      <button
                        className="btn primary"
                        style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => startCheckout(t.tier)}
                        disabled={busy === t.tier}
                      >
                        {busy === t.tier ? 'Redirecting…' : `Upgrade to ${t.label}`}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="billing-footnote mono">
              All prices in USD. Cancel anytime — credits remain usable until your renewal date. Billing handled by Stripe. Top-up packs ($15 per 1,000 credits) coming soon.
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
