'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon } from '../../../../../components/icons';
import type { CreditsPayload } from '../../../../../components/credits';
import { CREDIT_PRICES } from '../../../../../lib/credits/pricing';
import { apiPost, friendlyApiError, useApi } from '../../../../../lib/ui/fetcher';
import { openRazorpayModal } from '../../../../../components/billing/razorpay-checkout';
import { ledgerRowLabel } from '../../../../../lib/ui/ledgerLabel';
import { topupPriceView } from '../../../../../lib/billing/pricing';
import { BillingDetailsFields, useBillingDetails } from '../../../../../components/billing/billing-details';

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

type InvoiceRow = {
  id: string;
  kind: 'subscription' | 'topup' | 'upgrade';
  status: 'pending' | 'issued' | 'failed';
  number: string | null;
  url: string | null;
  currency: string;
  grossMinor: number;
  taxMinor: number;
  taxRatePct: number;
  description: string | null;
  createdAt: string;
};

const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

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
  subscriptionsAvailable: boolean;
  /** Display currency only — the charge is always INR. */
  currency: 'INR' | 'USD';
  provider: 'razorpay' | null;
  isIndia: boolean;
  canSwitchProvider: boolean;
  pendingTierChange: { toTier: 'starter' | 'pro' | 'business'; at: string | null } | null;
  tiers: Array<{
    tier: 'starter' | 'pro' | 'business';
    label: string;
    /** Local figure — approximate when `priceApproximate`. */
    priceMonthly: string;
    /** What Razorpay actually charges, always in ₹. */
    chargeMonthly: string;
    priceApproximate: boolean;
    amountMinor: number;
    credits: number;
    isCurrent: boolean;
  }>;
};

const TIER_RANK: Record<BillingPayload['currentTier'], number> = { starter: 0, pro: 1, business: 2 };

// "All 6 platforms", not seven: the Reddit adapter ships but its OAuth app
// isn't provisioned in production, so nobody can connect it. Raise to seven
// when it is.
const TIER_PERKS: Record<BillingPayload['currentTier'], string[]> = {
  starter: ['2,000 credits / month', 'All 6 platforms', 'Text, image & 720p video', 'Manual posting + scheduling', 'Email support'],
  pro: ['6,000 credits / month', 'All 6 platforms', 'Autopilot — trend → draft → schedule', 'Web research on captions', 'Priority email support'],
  business: ['25,000 credits / month', 'All 6 platforms', '1080p hero clips included', 'Autopilot with media generation', 'Daily reel guarantee · onboarding call'],
};

/** Shown to users whenever checkout can't start because payments aren't configured. */
const PAYMENTS_DOWN = 'Payments are temporarily unavailable. Please try again shortly.';
const LEDGER_PREVIEW = 10;

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingPageInner />
    </Suspense>
  );
}

function BillingPageInner() {
  const { data, mutate } = useApi<BillingPayload>('/api/billing');
  const { data: credits, isLoading: ledgerLoading } = useApi<CreditsPayload>('/api/credits', { refreshInterval: 30_000 });
  const params = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupBusy, setTopupBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  // null = not touched yet: plans start open only when there's nothing to manage.
  const [plansOpen, setPlansOpen] = useState<boolean | null>(null);
  const [showAllLedger, setShowAllLedger] = useState(false);
  const billing = useBillingDetails();
  const [detailsMsg, setDetailsMsg] = useState<string | null>(null);
  const { data: invoiceData } = useApi<{ invoices: InvoiceRow[] }>('/api/billing/invoices');

  const saveDetails = async () => {
    const err = await billing.save();
    setDetailsMsg(err ?? 'Saved. Future invoices will use these details.');
  };

  async function apiFetch<T>(url: string, init: RequestInit): Promise<T> {
    const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json() as Promise<T>;
  }

  // Operators get the details in the console; users only ever see PAYMENTS_DOWN.
  useEffect(() => {
    if (data && !data.billingConfigured) {
      console.error('[billing] Payment provider is not configured: checkout and top-up are disabled.');
    }
  }, [data]);

  const cancelSubscription = async () => {
    setCancelBusy(true);
    try {
      const r = await apiPost<{ periodEnd: string | null }>('/api/billing/cancel', {});
      const end = r.periodEnd ? new Date(r.periodEnd).toLocaleDateString() : 'your renewal date';
      setToast(`Subscription will end on ${end}.`);
      setCancelOpen(false);
      await mutate();
    } catch (e) {
      setToast(`Couldn't cancel: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    } finally {
      setCancelBusy(false);
    }
  };

  const clearPendingDowngrade = async () => {
    setBusy('clear-pending');
    try {
      const r = await apiFetch<{ cleared: boolean; caveat: string }>('/api/billing/change-tier', { method: 'DELETE' });
      setToast(r.caveat);
      await mutate();
    } catch (e) {
      setToast(`Couldn't clear pending switch: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // Checkout return: one-shot toast, then nudge SWR a few times so the balance
  // updates once the webhook lands. (A sticky "confirming" banner waiting for a
  // balance delta never cleared when the webhook beat the redirect.)
  useEffect(() => {
    const result = params.get('checkout');
    if (!result) return;
    if (result === 'success') {
      setToast('Payment received — credits will appear within a few seconds.');
      const t1 = setTimeout(() => mutate(), 2000);
      const t2 = setTimeout(() => mutate(), 6000);
      const t3 = setTimeout(() => mutate(), 12000);
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', '/settings/plan');
      }
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
    if (result === 'canceled') {
      setToast('Checkout canceled — no changes to your plan.');
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', '/settings/plan');
      }
    }
  }, [params, mutate]);

  // ?topup=1 (from the credit meter / out-of-credits banner) opens the top-up sheet.
  useEffect(() => {
    if (!params.get('topup') || !data) return;
    if (data.billingConfigured) setTopupOpen(true);
    window.history.replaceState(null, '', '/settings/plan');
  }, [params, data]);

  const dispatchHandoff = async (handoff: CheckoutHandoff) => {
    if (handoff.kind === 'redirect') {
      if (typeof window !== 'undefined') {
        window.location.assign(handoff.url);
      }
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
      if (msg.includes('503') || msg.includes('billing_coming_soon')) {
        console.error('[billing] checkout unavailable:', msg);
        setToast(PAYMENTS_DOWN);
      } else {
        // friendlyApiError turns `Error("<status>: <json>")` into the server's
        // `hint` sentence. Never interpolate the raw message.
        setToast(friendlyApiError(e));
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
      setToast(`Couldn't switch tier — ${friendlyApiError(e)}`);
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
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('503') || msg.includes('billing_coming_soon')) {
        console.error('[billing] top-up unavailable:', msg);
        setToast(PAYMENTS_DOWN);
      } else {
        setToast(friendlyApiError(e));
      }
    } finally {
      setTopupBusy(false);
    }
  };

  const showInr = async () => {
    try {
      await apiPost('/api/billing/preferences', { currency: 'INR' });
      await mutate();
    } catch (e) {
      setToast(`Couldn't switch currency: ${friendlyApiError(e)}`);
    }
  };

  const cycleEnd = data?.subscriptionCurrentPeriodEnd ? new Date(data.subscriptionCurrentPeriodEnd) : null;
  // Ticking "now" keeps render pure and accurate through midnight.
  const [now, setNow] = useState<number>(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const daysLeft = cycleEnd && now > 0
    ? Math.max(0, Math.ceil((cycleEnd.getTime() - now) / (24 * 60 * 60 * 1000)))
    : null;
  const pct = data && data.monthlyAllocation > 0
    ? Math.min(100, Math.round((data.balance / data.monthlyAllocation) * 100))
    : 0;
  const barState = pct <= 5 ? 'crit' : pct <= 15 ? 'warn' : '';

  // Escape closes whichever modal is up; the cancel dialog honours its in-flight guard.
  useEffect(() => {
    if (!topupOpen && !cancelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setTopupOpen(false);
      if (!cancelBusy) setCancelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [topupOpen, cancelOpen, cancelBusy]);

  const active = !!data?.hasActiveSubscription;
  const currentTier = data?.tiers.find((t) => t.isCurrent);
  const showPlans = plansOpen ?? (!!data && !active);
  const ledger = credits?.ledger ?? [];
  const visibleLedger = showAllLedger ? ledger : ledger.slice(0, LEDGER_PREVIEW);
  const invoices = invoiceData?.invoices ?? [];

  return (
    <div className="plan-page">
      {toast && <div className="set-notice" role="status">{toast}</div>}

      <section className="card plan-balance" aria-label="Credit balance">
        <div className="plan-balance-top">
          <div>
            <div className="plan-label">Credits</div>
            <div className="plan-big mono">{data ? data.balance.toLocaleString() : '—'}</div>
            <div className="plan-sub">
              {active
                ? <>of {data!.monthlyAllocation.toLocaleString()} this cycle
                    {daysLeft !== null && <> · {daysLeft === 0 ? 'renews today' : daysLeft === 1 ? 'renews tomorrow' : `renews in ${daysLeft} days`}</>}
                  </>
                : data ? 'No active plan' : ' '}
            </div>
          </div>
          <button className={active ? "btn primary" : "btn"} onClick={() => setTopupOpen(true)} disabled={!data?.billingConfigured}>
            <Icon name="plus" size={14} /> Top up
          </button>
        </div>
        {active && (
          <div className={`meter-bar ${barState}`} role="presentation">
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
        )}
        {data && !data.billingConfigured && <p className="plan-note">{PAYMENTS_DOWN}</p>}
      </section>

      <section className="card" aria-labelledby="plan-head">
        <div className="card-head">
          <h3 id="plan-head">Plan</h3>
          <button className="btn sm" onClick={() => setPlansOpen(!showPlans)} aria-expanded={showPlans}>
            {showPlans ? 'Hide plans' : 'Change plan'}
          </button>
        </div>
        <div className="card-body">
          <div className="plan-current">
            {active && currentTier ? (
              <div>
                <div className="plan-current-name">{currentTier.label}</div>
                <div className="plan-sub">{currentTier.chargeMonthly} / month</div>
              </div>
            ) : (
              <div className="plan-sub">{data ? 'Choose a plan to start posting.' : ' '}</div>
            )}
            {data?.subscriptionStatus && data.subscriptionStatus !== 'active' && (
              <span className="badge badge--warn">{data.subscriptionStatus.replace(/_/g, ' ')}</span>
            )}
          </div>
          {data?.pendingTierChange && (
            <div className="plan-pending">
              <span>
                Switches to {data.pendingTierChange.toTier} on{' '}
                {data.pendingTierChange.at ? new Date(data.pendingTierChange.at).toLocaleDateString() : 'cycle end'}.
                Current credits stay usable until then.
              </span>
              <button className="btn sm" onClick={clearPendingDowngrade} disabled={busy === 'clear-pending'}>
                {busy === 'clear-pending' ? 'Working…' : 'Cancel switch'}
              </button>
            </div>
          )}
        </div>

        {showPlans && (
          <div className="plan-grid">
            {(data?.tiers ?? []).map((t) => (
              <div key={t.tier} className={`plan-tier ${t.isCurrent ? 'current' : ''}`}>
                <div className="plan-tier-name">
                  {t.label}
                  {t.isCurrent && <span className="badge">Current</span>}
                </div>
                <div className="plan-tier-price">{t.priceMonthly}<span className="per"> / month</span></div>
                {/* The customer must see the currency they'll actually be charged before subscribing. */}
                {t.priceApproximate && (
                  <div className="plan-tier-charge">Billed as {t.chargeMonthly} / month in INR</div>
                )}
                <ul>
                  {TIER_PERKS[t.tier].map((perk) => <li key={perk}>{perk}</li>)}
                </ul>
                {t.isCurrent ? (
                  <button className="btn" disabled>Current plan</button>
                ) : !data?.subscriptionsAvailable ? (
                  <button className="btn" disabled title="Monthly plans aren't live yet. Top up credits for now.">
                    Coming soon — monthly plans
                  </button>
                ) : data?.hasActiveSubscription ? (
                  <button className="btn" onClick={() => changeTier(t.tier)} disabled={busy === t.tier}>
                    {busy === t.tier ? 'Working…' :
                      TIER_RANK[t.tier] > TIER_RANK[data!.currentTier]
                        ? `Upgrade to ${t.label}`
                        : `Downgrade to ${t.label}`}
                  </button>
                ) : (
                  <button className="btn" onClick={() => startCheckout(t.tier)} disabled={busy === t.tier}>
                    {busy === t.tier
                      ? 'Redirecting…'
                      // Currency in the label: no one pays in rupees without reading "INR" first.
                      : t.priceApproximate
                        ? `Subscribe — ${t.chargeMonthly}/mo INR`
                        : `Subscribe to ${t.label}`}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {data && (
          <div className="plan-currency">
            {data.currency === 'INR'
              ? 'Charged in ₹ INR with a GST invoice.'
              : 'Charged in ₹ INR. Dollar figures are approximate; your bank sets the conversion rate.'}
            {data.canSwitchProvider && data.currency !== 'INR' && (
              <button className="set-link" onClick={showInr}>Show ₹ prices</button>
            )}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="activity-head">
        <div className="card-head"><h3 id="activity-head">Credit activity</h3></div>
        <div className="plan-rows">
          {ledgerLoading && <div className="plan-empty">Loading…</div>}
          {!ledgerLoading && ledger.length === 0 && (
            <div className="plan-empty">No credit activity yet.</div>
          )}
          {visibleLedger.map((row) => <LedgerRow key={row.id} row={row} />)}
        </div>
        <div className="plan-card-foot">
          <span>
            {/* Read off the charge table, never retyped. */}
            Text {CREDIT_PRICES.text_post} · image {CREDIT_PRICES.image_medium_1024} · 720p reel {CREDIT_PRICES.video_8s_720p_quality}
            {' '}· 1080p hero {CREDIT_PRICES.video_15s_1080p_quality} credits. Failed generations refund automatically.
          </span>
          {ledger.length > LEDGER_PREVIEW && (
            <button className="set-link" onClick={() => setShowAllLedger((v) => !v)}>
              {showAllLedger ? 'Show less' : `Show all ${ledger.length}`}
            </button>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="invoices-head">
        <div className="card-head"><h3 id="invoices-head">Invoices</h3></div>
        <div className="plan-rows">
          {invoices.length === 0 ? (
            <div className="plan-empty">No invoices yet. One is issued for every payment.</div>
          ) : invoices.map((inv) => (
            <div key={inv.id} className="plan-row">
              <div className="plan-row-main">
                <div>{inv.description ?? inv.kind}</div>
                <div className="plan-row-meta">
                  {new Date(inv.createdAt).toLocaleDateString()}{inv.number && <> · {inv.number}</>}
                </div>
              </div>
              <span className="num" title={`incl. ${rupees(inv.taxMinor)} GST @ ${inv.taxRatePct}%`}>{rupees(inv.grossMinor)}</span>
              {inv.url ? (
                <a className="btn ghost sm" href={inv.url} target="_blank" rel="noreferrer">Download</a>
              ) : (
                // Money moved and credits landed; only the document is late.
                <span className="plan-row-when">{inv.status === 'failed' ? 'Retrying…' : 'Preparing…'}</span>
              )}
            </div>
          ))}
        </div>
        <details className="plan-details">
          <summary>Invoice details — legal name, GSTIN, address</summary>
          <div className="plan-details-body">
            <p className="set-hint">
              Add your GSTIN before your next charge to get a B2B tax invoice. Issued invoices can&apos;t be amended.
            </p>
            <BillingDetailsFields value={billing.value} set={billing.set} setAddress={billing.setAddress} />
            <div className="set-actions">
              <button className="btn primary" onClick={saveDetails} disabled={billing.saving || !billing.loaded}>
                {billing.saving ? 'Saving…' : 'Save details'}
              </button>
              {detailsMsg && (
                <span className={billing.validate() ? 'set-hint err' : 'set-hint'}>{detailsMsg}</span>
              )}
            </div>
          </div>
        </details>
      </section>

      <footer className="plan-foot">
        <span>
          Charges are in ₹ INR. Credits stay usable until your renewal date if you cancel.
          {' '}<a href="/legal/refund">Refund &amp; cancellation policy</a>.
        </span>
        <span>Sociafy is a product of GNIX SEMICONDUCTORS PRIVATE LIMITED, 2TF, Satyam Complex 2, Sector Alpha II, Greater Noida, Uttar Pradesh 201310, India.</span>
        {active && (
          <button className="set-link" onClick={() => setCancelOpen(true)} disabled={cancelBusy}>
            {cancelBusy ? 'Canceling…' : 'Cancel subscription'}
          </button>
        )}
      </footer>

      {topupOpen && (
        <div role="dialog" aria-modal="true" aria-labelledby="topup-head" className="modal-scrim" onClick={() => setTopupOpen(false)}>
          <div className="modal-sheet plan-modal" onClick={(e) => e.stopPropagation()}>
            <h3 id="topup-head">Top up credits</h3>
            <p>
              {topupPriceView(data?.currency ?? 'INR').display} per 1,000 credits, charged once
              {data?.currency === 'INR' ? '' : ' in ₹ INR (dollar figures are approximate)'}.
            </p>
            <div className="stack">
              {[1000, 2000, 5000].map((n) => {
                const v = topupPriceView(data?.currency ?? 'INR', n);
                return (
                  <button key={n} className="btn" onClick={() => buyTopUp(n)} disabled={topupBusy}>
                    <span>{n.toLocaleString()} credits</span>
                    {/* An approximate figure never stands alone next to a pay action. */}
                    <span className="mono">{v.approximate ? `${v.display} · ${v.charge}` : v.charge}</span>
                  </button>
                );
              })}
            </div>
            <div className="plan-modal-actions">
              <button className="btn ghost" onClick={() => setTopupOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {cancelOpen && (
        <div role="dialog" aria-modal="true" aria-labelledby="cancel-head" className="modal-scrim" onClick={() => { if (!cancelBusy) setCancelOpen(false); }}>
          <div className="modal-sheet plan-modal" onClick={(e) => e.stopPropagation()}>
            <h3 id="cancel-head">Cancel subscription?</h3>
            <p>
              Your plan stays active until {cycleEnd ? cycleEnd.toLocaleDateString() : 'your renewal date'} and your
              credits stay usable until then. After that it won&apos;t renew and autopilot stops. You can resubscribe anytime.
            </p>
            <div className="plan-modal-actions">
              <button className="btn ghost" onClick={() => setCancelOpen(false)} disabled={cancelBusy}>
                Keep plan
              </button>
              <button className="btn danger" onClick={cancelSubscription} disabled={cancelBusy}>
                {cancelBusy ? 'Canceling…' : 'Cancel subscription'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const LedgerRow: React.FC<{ row: CreditsPayload['ledger'][number] }> = ({ row }) => {
  const { title, detail } = ledgerRowLabel(row);
  return (
    <div className="plan-row">
      <div className="plan-row-main">
        <div>{title}</div>
        {detail && <div className="plan-row-meta">{detail}</div>}
      </div>
      <span className={`num ${row.credits > 0 ? 'pos' : ''}`}>
        {row.credits > 0 ? '+' : ''}{row.credits.toLocaleString()}
      </span>
      <span className="plan-row-when">{relTime(row.createdAt)}</span>
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
