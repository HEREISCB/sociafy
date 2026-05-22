'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Sidebar, Topbar } from '../../components/shell';
import { Icon } from '../../components/icons';
import { apiPost, useApi } from '../../lib/ui/fetcher';
import { openRazorpayModal } from '../../components/billing/razorpay-checkout';

type CheckoutHandoff =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'razorpay_modal';
      keyId: string;
      subscriptionId?: string;
      orderId?: string;
      amountMinor: number;
      currency: 'INR';
      description: string;
      prefill: { email?: string; name?: string };
      notes: Record<string, string>;
    };

type Page = 'dashboard' | 'compose' | 'agent' | 'calendar' | 'connections' | 'onboarding';

type BillingPayload = {
  currentTier: 'starter' | 'pro' | 'business';
  currentTierLabel: string;
  monthlyAllocation: number;
  balance: number;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  stripeCustomerId: string | null;
  razorpayCustomerId: string | null;
  hasActiveSubscription: boolean;
  billingConfigured: boolean;
  currency: 'INR' | 'USD';
  provider: 'razorpay' | 'stripe' | null;
  isIndia: boolean;
  canSwitchProvider: boolean;
  pendingTierChange: { toTier: 'starter' | 'pro' | 'business'; at: string | null } | null;
  tiers: Array<{
    tier: 'starter' | 'pro' | 'business';
    label: string;
    priceMonthly: string;
    amountMinor: number;
    credits: number;
    isCurrent: boolean;
  }>;
};

const TIER_RANK: Record<BillingPayload['currentTier'], number> = { starter: 0, pro: 1, business: 2 };

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
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupBusy, setTopupBusy] = useState(false);

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

  const dispatchHandoff = async (handoff: CheckoutHandoff) => {
    if (handoff.kind === 'redirect') {
      window.location.href = handoff.url;
      return;
    }
    await openRazorpayModal(handoff, {
      onDismiss: () => setToast('Checkout canceled — no changes to your plan.'),
    });
  };

  const startCheckout = async (tier: 'starter' | 'pro' | 'business') => {
    setBusy(tier);
    try {
      const handoff = await apiPost<CheckoutHandoff>('/api/billing/checkout', { tier });
      await dispatchHandoff(handoff);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('503')) {
        setToast('Billing isn\'t configured yet — Razorpay keys missing in .env.local.');
      } else {
        setToast(`Checkout failed: ${msg.slice(0, 160)}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const changeTier = async (toTier: 'starter' | 'pro' | 'business') => {
    setBusy(toTier);
    try {
      const result = await apiPost<{ kind: 'immediate' | 'scheduled'; effectiveAt: string; handoff?: CheckoutHandoff }>(
        '/api/billing/change-tier',
        { toTier },
      );
      if (result.kind === 'immediate' && result.handoff) {
        await dispatchHandoff(result.handoff);
      } else if (result.kind === 'scheduled') {
        setToast(`Plan will switch to ${toTier} on ${new Date(result.effectiveAt).toLocaleDateString()}.`);
        await mutate();
      } else {
        setToast('Plan switched.');
        await mutate();
      }
    } catch (e) {
      setToast(`Couldn't switch tier: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const buyTopUp = async (credits: number) => {
    setTopupBusy(true);
    try {
      const handoff = await apiPost<CheckoutHandoff>('/api/billing/topup', { credits });
      setTopupOpen(false);
      await dispatchHandoff(handoff);
    } catch (e) {
      setToast(`Top-up failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    } finally {
      setTopupBusy(false);
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
                <strong>Razorpay isn&apos;t configured yet.</strong>
                <span className="muted"> Add RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, and the three RAZORPAY_PLAN_* env vars to .env.local. Until then, upgrades just show this page.</span>
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
              <div style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => setTopupOpen(true)} disabled={!data?.hasActiveSubscription}>
                  <span aria-hidden style={{ marginRight: 4 }}>+</span> Top up credits
                </button>
                {!data?.hasActiveSubscription && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>Subscribe first to enable top-ups.</span>
                )}
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

            {data?.pendingTierChange && (
              <div className="insufficient-credits-banner" style={{ background: '#eef6ff', borderColor: '#bcd4f0' }}>
                <div className="icon" style={{ background: '#cfe3fb', color: '#264b7a' }}>i</div>
                <div className="copy" style={{ flex: 1 }}>
                  <strong>Switches to {data.pendingTierChange.toTier} on {data.pendingTierChange.at ? new Date(data.pendingTierChange.at).toLocaleDateString() : 'cycle end'}.</strong>
                  <span className="muted"> Credits from your current tier remain usable until then.</span>
                </div>
                <button className="btn ghost" onClick={() => {}} disabled={busy === 'clear-pending'}>
                  {busy === 'clear-pending' ? '…' : 'Cancel switch'}
                </button>
              </div>
            )}

            {data && data.canSwitchProvider && (
              <div className="billing-currency-banner" style={{
                padding: '10px 14px',
                background: 'var(--accent-soft)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                marginBottom: 16,
                fontSize: 13,
              }}>
                {data.currency === 'INR' ? (
                  <>Pay in <strong>₹ INR via Razorpay</strong>. USD billing coming soon.</>
                ) : (
                  <>USD billing via Stripe — <em>coming soon</em>.{' '}
                    <button
                      className="btn ghost"
                      style={{ marginLeft: 8 }}
                      onClick={async () => {
                        try {
                          await apiPost('/api/billing/preferences', { currency: 'INR' });
                          await mutate();
                        } catch (e) {
                          setToast(`Couldn't switch currency: ${e instanceof Error ? e.message : String(e)}`);
                        }
                      }}
                    >Pay in ₹ INR via Razorpay instead</button>
                  </>
                )}
              </div>
            )}
            {data && !data.canSwitchProvider && (
              <div className="billing-currency-banner" style={{
                padding: '10px 14px',
                background: 'transparent',
                borderRadius: 10,
                marginBottom: 16,
                fontSize: 12,
                color: 'var(--muted)',
              }}>
                Billing in <strong>{data.currency === 'INR' ? '₹ INR via Razorpay' : '$ USD via Stripe'}</strong> · cancel to change
              </div>
            )}

            <section className="billing-tiers">
              <h2 className="billing-section-head">Switch plan</h2>
              <div className="billing-tier-grid">
                {(data?.tiers ?? []).map((t) => (
                  <div key={t.tier} className={`billing-tier-card ${t.isCurrent ? 'current' : ''}`}>
                    {t.isCurrent && <div className="current-badge mono">Current</div>}
                    <div className="tier-label">{t.label}</div>
                    <div className="tier-price">{t.priceMonthly}<span className="per">/mo</span></div>
                    <ul className="tier-perks">
                      {TIER_PERKS[t.tier].map((perk) => (
                        <li key={perk}>{perk}</li>
                      ))}
                    </ul>
                    {t.isCurrent ? (
                      <button className="btn" disabled style={{ width: '100%', justifyContent: 'center' }}>
                        <Icon name="check" size={12} /> Current plan
                      </button>
                    ) : data?.currency === 'USD' ? (
                      <button className="btn" disabled style={{ width: '100%', justifyContent: 'center' }}>
                        USD billing coming soon
                      </button>
                    ) : data?.hasActiveSubscription ? (
                      <button
                        className="btn primary"
                        style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => changeTier(t.tier)}
                        disabled={busy === t.tier}
                      >
                        {busy === t.tier ? 'Working…' :
                          TIER_RANK[t.tier] > TIER_RANK[data!.currentTier]
                            ? `Upgrade to ${t.label}`
                            : `Downgrade to ${t.label}`}
                      </button>
                    ) : (
                      <button
                        className="btn primary"
                        style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => startCheckout(t.tier)}
                        disabled={busy === t.tier}
                      >
                        {busy === t.tier ? 'Redirecting…' : `Subscribe to ${t.label}`}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="billing-footnote mono">
              All prices in {data?.currency === 'INR' ? 'INR' : 'USD'}. Cancel anytime — credits remain usable until your renewal date. Billing handled by {data?.provider === 'razorpay' ? 'Razorpay' : 'Stripe'}. Top-up packs coming soon.
            </section>
          </div>
        </div>
      </div>
      {topupOpen && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setTopupOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)', borderRadius: 12, padding: 20,
              width: 'min(420px, 92vw)', boxShadow: '0 20px 60px rgba(0,0,0,.3)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Top up credits</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              {data?.currency === 'INR' ? '₹1,499' : '$15'} per 1,000 credits. Charged once.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              {[1000, 2000, 5000].map((n) => (
                <button
                  key={n}
                  className="btn primary"
                  style={{ justifyContent: 'space-between' }}
                  onClick={() => buyTopUp(n)}
                  disabled={topupBusy}
                >
                  <span>{n.toLocaleString()} credits</span>
                  <span className="mono">{data?.currency === 'INR' ? `₹${(1499 * (n / 1000)).toLocaleString()}` : `$${15 * (n / 1000)}`}</span>
                </button>
              ))}
            </div>
            <button className="btn ghost" style={{ marginTop: 12, width: '100%' }} onClick={() => setTopupOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
