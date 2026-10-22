'use client';

import React, { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { mutate as mutateKey } from 'swr';
import { Icon } from '../../../../../components/icons';
import { Button, Modal, useToast } from '../../../../../components/ui';
import { CREDIT_PRICES, MOTION_PER_SEC } from '../../../../../lib/credits/pricing';
import { apiPost, friendlyApiError, useApi } from '../../../../../lib/ui/fetcher';
import { openRazorpayModal } from '../../../../../components/billing/razorpay-checkout';
import { topupPriceView } from '../../../../../lib/billing/pricing';
import { gstTreatment, splitInclusive } from '../../../../../lib/billing/gst';
import type { BillingDetailsValue } from '../../../../../components/billing/billing-details';
import { inr, num, shortDate } from '../../../../../components/billing/account-ui';

type Tier = 'starter' | 'pro' | 'business';

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

type BillingPayload = {
  currentTier: Tier;
  currentTierLabel: string;
  monthlyAllocation: number;
  balance: number;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  hasActiveSubscription: boolean;
  billingConfigured: boolean;
  subscriptionsAvailable: boolean;
  /** Display currency only — the charge is always INR. */
  currency: 'INR' | 'USD';
  canSwitchProvider: boolean;
  cancelsAt: string | null;
  pendingTierChange: { toTier: Tier; at: string | null } | null;
  tiers: Array<{
    tier: Tier;
    label: string;
    priceMonthly: string;
    chargeMonthly: string;
    priceApproximate: boolean;
    amountMinor: number;
    credits: number;
    isCurrent: boolean;
    upgrade: { dueMinor: number; creditsNow: number } | null;
  }>;
};

const TIER_RANK: Record<Tier, number> = { starter: 0, pro: 1, business: 2 };

// Credit counts come from the API (TIER_CREDITS), never retyped here. These are
// the perks the owner has listed so far; none is enforced in code yet, so the
// copy says what each plan is for rather than what the others can't do.
const TIER_PERKS: Record<Tier, string[]> = {
  starter: ['Text, image & 720p video', 'Scheduling on all 6 platforms', 'Email support'],
  pro: ['Everything in Starter', 'Autopilot: trend → draft → schedule', 'Web research on captions'],
  business: ['Everything in Pro', '1080p hero clips', 'Onboarding call'],
};

const PACKS = [1000, 2000, 5000] as const;
const PAYMENTS_DOWN = 'Payments are unavailable right now. Try again shortly.';
const REEL = CREDIT_PRICES.video_8s_720p_quality;
const IMAGE = CREDIT_PRICES.image_medium_1024;

type SheetState = null | { kind: 'topup' } | { kind: 'cancel' } | { kind: 'upgrade' | 'down'; tier: Tier };

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingPageInner />
    </Suspense>
  );
}

function BillingPageInner() {
  const { data, mutate } = useApi<BillingPayload>('/api/billing');
  const { data: details } = useApi<BillingDetailsValue>('/api/billing/details');
  const params = useSearchParams();
  const toast = useToast();
  const [sheet, setSheet] = useState<SheetState>(null);
  const [pack, setPack] = useState<number>(2000);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => Promise.all([mutate(), mutateKey('/api/credits')]);

  // The balance re-arrives only when SWR sees a real change (a webhook landed),
  // never on a timer.
  const [arriveKey, setArriveKey] = useState(0);
  const prevBalance = useRef<number | null>(null);
  useEffect(() => {
    if (!data) return;
    if (prevBalance.current !== null && prevBalance.current !== data.balance) setArriveKey((k) => k + 1);
    prevBalance.current = data.balance;
  }, [data]);

  // Operators get the details in the console; users see PAYMENTS_DOWN.
  useEffect(() => {
    if (data && !data.billingConfigured) {
      console.error('[billing] Payment provider is not configured: checkout and top-up are disabled.');
    }
  }, [data]);

  // Checkout return: one toast, then nudge SWR until the webhook's credits show.
  useEffect(() => {
    const result = params.get('checkout');
    if (!result) return;
    window.history.replaceState(null, '', '/account/billing');
    if (result === 'success') {
      toast('Payment received. Adding your credits…');
      const ts = [2000, 6000, 12000, 20000].map((ms) => setTimeout(() => { void mutate(); void mutateKey('/api/credits'); }, ms));
      return () => ts.forEach(clearTimeout);
    }
    if (result === 'canceled') toast('Checkout closed. Nothing was charged.');
  }, [params, mutate, toast]);

  // ?topup=1 (header button, out-of-credits banner) opens the top-up sheet.
  // It opens even when payments are down, so the reason is visible instead of
  // the link silently doing nothing.
  useEffect(() => {
    if (!params.get('topup')) return;
    setSheet({ kind: 'topup' });
    window.history.replaceState(null, '', '/account/billing');
  }, [params]);

  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('503') || msg.includes('billing_coming_soon')) {
      console.error('[billing] payments unavailable:', msg);
      toast(PAYMENTS_DOWN, { tone: 'err' });
    } else {
      toast(friendlyApiError(e), { tone: 'err' });
    }
  };

  const dispatchHandoff = async (handoff: CheckoutHandoff) => {
    if (handoff.kind === 'redirect') {
      window.location.assign(handoff.url);
      return;
    }
    await openRazorpayModal(handoff, { onDismiss: () => toast('Checkout closed. Nothing was charged.') });
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const subscribe = (tier: Tier) => run(tier, async () => {
    await dispatchHandoff(await apiPost<CheckoutHandoff>('/api/billing/checkout', { tier }));
  });

  const changeTier = (tier: Tier) => run('change', async () => {
    const r = await apiPost<{ kind: 'immediate' | 'scheduled'; effectiveAt: string; handoff?: CheckoutHandoff }>(
      '/api/billing/change-tier', { toTier: tier },
    );
    setSheet(null);
    if (r.handoff) return dispatchHandoff(r.handoff);
    toast(r.kind === 'scheduled' ? `Scheduled: ${label(tier)} from ${shortDate(r.effectiveAt)}.` : 'Plan switched.');
    await refresh();
  });

  const buyTopUp = () => run('topup', async () => {
    const handoff = await apiPost<CheckoutHandoff>('/api/billing/topup', { credits: pack });
    setSheet(null);
    await dispatchHandoff(handoff);
  });

  const cancel = () => run('cancel', async () => {
    const r = await apiPost<{ periodEnd: string | null }>('/api/billing/cancel', {});
    setSheet(null);
    toast(r.periodEnd ? `Plan ends ${shortDate(r.periodEnd)}. You won’t be charged again.` : 'Cancelled. You won’t be charged again.');
    await refresh();
  });

  const active = !!data?.hasActiveSubscription;
  const current = data?.tiers.find((t) => t.isCurrent) ?? null;
  const periodEnd = data?.subscriptionCurrentPeriodEnd ?? null;
  const endLabel = periodEnd ? shortDate(periodEnd) : 'your renewal date';
  const cancelsAt = data?.cancelsAt ?? null;
  const pending = data?.pendingTierChange ?? null;
  const fill = data && active && data.monthlyAllocation > 0 ? Math.min(1, data.balance / data.monthlyAllocation) : 0;
  const [now] = useState(() => Date.now());
  const daysLeft = periodEnd ? Math.max(0, Math.ceil((new Date(periodEnd).getTime() - now) / 86_400_000)) : null;

  const sheetTier = sheet && 'tier' in sheet ? data?.tiers.find((t) => t.tier === sheet.tier) ?? null : null;
  const topup = topupPriceView(data?.currency ?? 'INR', pack);
  const tax = gstTreatment({ country: details?.billingAddress?.country ?? details?.billingCountry, placeOfSupply: details?.placeOfSupply, gstin: details?.gstin });

  return (
    <div className="acct-page">
      {data?.subscriptionStatus === 'past_due' && (
        <div className="acct-banner" role="alert">
          <Icon name="alert" size={14} />
          <span>
            Razorpay couldn’t charge your card for the {data.currentTierLabel === 'No plan' ? '' : `${label(data.currentTier)} `}plan.
            Retry from Razorpay’s email, or top up to keep generating. Your credits still work.
          </span>
        </div>
      )}
      {data?.subscriptionStatus === 'incomplete' && (
        <div className="acct-banner" role="status">
          <Icon name="clock" size={14} />
          <span>Your {label(data.currentTier)} plan is waiting for you to approve it in Razorpay. Check your email for the link.</span>
        </div>
      )}

      <section className="card acct-bal-card" aria-label="Credit balance">
        <div className="acct-label">Credits left</div>
        <div className="acct-bal-top">
          <div key={arriveKey} className={`acct-big mono${arriveKey ? ' arrive' : ''}`}>
            {data ? num(data.balance) : '—'}<small>cr</small>
          </div>
          <Link className="acct-link" href="/account/usage">See where they went</Link>
        </div>
        {active && (
          <div className="acct-meter" aria-hidden="true"><i style={{ transform: `scaleX(${fill})` }} /></div>
        )}
        <p className="acct-note">
          {!data ? ' '
            : !active ? 'Credits from top-ups and grants. Nothing renews, and credits don’t expire.'
            : cancelsAt ? <>of {num(data.monthlyAllocation)} this cycle · plan ends <b>{shortDate(cancelsAt)}</b>; your credits stay usable after that</>
            : <>of {num(data.monthlyAllocation)} this cycle · renews <b>{endLabel}</b> with {num(data.monthlyAllocation)} more · unused credits stay</>}
        </p>
        {data && (
          <p className="acct-buys">
            Enough for ≈ <span className="mono">{num(Math.floor(data.balance / REEL))}</span> AI reels,
            or <span className="mono">{num(Math.floor(data.balance / IMAGE))}</span> images,
            or <span className="mono">{num(Math.floor(data.balance / CREDIT_PRICES.text_post))}</span> captions
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="plan-head">
        <div className="card-head acct-card-head">
          <h3 id="plan-head">Plan</h3>
          {data && (
            <span key={`${cancelsAt}${pending?.toTier}`} className={`badge acct-swap ${!active ? '' : cancelsAt || pending ? 'warn' : 'ok'}`}>
              {!active ? 'No plan · paying as you go'
                : cancelsAt ? `${current?.label} · ends ${shortDate(cancelsAt)} · won’t renew`
                : pending ? `${current?.label} · switches to ${label(pending.toTier)} on ${pending.at ? shortDate(pending.at) : endLabel}`
                : `${current?.label} · ${current?.chargeMonthly}/mo · renews ${endLabel}`}
            </span>
          )}
        </div>
        <div className="acct-tiers">
          {(data?.tiers ?? []).map((t) => {
            const up = active && data && TIER_RANK[t.tier] > TIER_RANK[data.currentTier];
            let btn: React.ReactNode;
            let why = '';
            if (t.isCurrent) {
              btn = <Button disabled>Your plan</Button>;
              why = cancelsAt ? `Ends ${shortDate(cancelsAt)}` : pending ? `Until ${pending.at ? shortDate(pending.at) : endLabel}` : `Renews ${endLabel}`;
            } else if (!data?.billingConfigured) {
              btn = <Button disabled>{active ? (up ? 'Upgrade' : 'Switch') : 'Subscribe'}</Button>;
              why = PAYMENTS_DOWN;
            } else if (!data.subscriptionsAvailable) {
              btn = <Button disabled>Subscribe</Button>;
              why = 'Monthly plans aren’t live yet. Top up instead.';
            } else if (active && cancelsAt) {
              btn = <Button disabled>{up ? 'Upgrade' : 'Switch'}</Button>;
              why = `Available after ${shortDate(cancelsAt)}`;
            } else if (active && pending) {
              btn = <Button disabled>{pending.toTier === t.tier ? `Switching ${pending.at ? shortDate(pending.at) : ''}` : up ? 'Upgrade' : 'Switch'}</Button>;
              why = pending.toTier === t.tier ? `${current?.label} stays until then` : 'A switch is already scheduled';
            } else if (up && t.upgrade) {
              btn = (
                <Button variant="primary" onClick={() => setSheet({ kind: 'upgrade', tier: t.tier })}>
                  Upgrade <span className="cost">{inr(t.upgrade.dueMinor)} today</span>
                </Button>
              );
              why = daysLeft !== null ? `Prorated for ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'Prorated for the rest of this cycle';
            } else if (active) {
              btn = <Button onClick={() => setSheet({ kind: 'down', tier: t.tier })}>Switch on {endLabel}</Button>;
              why = 'No charge today';
            } else {
              btn = (
                <Button busy={busy === t.tier} onClick={() => subscribe(t.tier)}>
                  {busy === t.tier ? 'Opening Razorpay…' : <>Subscribe <span className="cost">{t.chargeMonthly}/mo</span></>}
                </Button>
              );
              why = t.priceApproximate ? `Charged ${t.chargeMonthly} in INR` : 'Opens Razorpay';
            }
            return (
              <div key={t.tier} className={`acct-tier${t.isCurrent ? ' cur' : ''}`}>
                <div className="acct-tier-name">{t.label}{t.isCurrent && <span className="badge acct-ink">Current</span>}</div>
                <div className="acct-price">{t.priceMonthly}<small> / month</small></div>
                <ul>
                  <li className="mono">{num(t.credits)} credits / month</li>
                  {TIER_PERKS[t.tier].map((p) => <li key={p}>{p}</li>)}
                </ul>
                {btn}
                <div className="acct-why">{why}</div>
              </div>
            );
          })}
          {!data && [0, 1, 2].map((i) => <div key={i} className="acct-tier"><span className="skel" style={{ height: 160 }} /></div>)}
        </div>
        <div className="acct-card-foot">
          <span>
            Charged in ₹ INR incl. 18% GST, with a tax invoice.
            {data?.currency === 'USD' && ' Dollar figures are approximate.'}{' '}
            <Link href="/legal/refund">Refund &amp; cancellation policy</Link>
          </span>
          <span className="acct-cancel">
            <Button
              size="sm"
              disabled={!active || !!cancelsAt}
              reason={!active ? 'No plan to cancel' : cancelsAt ? `Ends ${shortDate(cancelsAt)}. Pick a plan again after that.` : undefined}
              onClick={() => setSheet({ kind: 'cancel' })}
            >
              Cancel plan
            </Button>
          </span>
        </div>
      </section>

      <section className="card" aria-labelledby="costs-head">
        <div className="card-head acct-card-head">
          <h3 id="costs-head">What things cost</h3>
          <span className="acct-note">Every button that spends shows its cost</span>
        </div>
        <div className="card-body">
          {/* Read off the charge table, never retyped. */}
          <div className="acct-costs">
            <div><span>Caption</span><span>{CREDIT_PRICES.text_post} cr</span></div>
            <div><span>Caption <em>with web research</em></span><span>{CREDIT_PRICES.text_post_research} cr</span></div>
            <div><span>Image <em>standard</em></span><span>{IMAGE} cr</span></div>
            <div><span>Image <em>high quality</em></span><span>{CREDIT_PRICES.image_high_portrait}–{CREDIT_PRICES.image_high_1024} cr</span></div>
            <div><span>Photo used as reference</span><span>+{CREDIT_PRICES.image_reference} cr</span></div>
            <div><span>Motion graphic</span><span>{MOTION_PER_SEC} cr / s</span></div>
            <div><span>AI video <em>8 s · 720p</em></span><span>{num(REEL)} cr</span></div>
            <div><span>AI video <em>15 s · 1080p</em></span><span>{num(CREDIT_PRICES.video_15s_1080p_quality)} cr</span></div>
            <div><span>Avatar video <em>480p / 720p</em></span><span>{CREDIT_PRICES.avatar_video_480p} / {CREDIT_PRICES.avatar_video_720p} cr</span></div>
            <div><span>Voiceover</span><span>{CREDIT_PRICES.tts_synthesis} cr</span></div>
          </div>
          <p className="acct-note" style={{ marginTop: 12 }}>
            Failed generations refund automatically. Top-ups cost {topupPriceView('INR').charge} per 1,000 credits incl. GST.
          </p>
        </div>
      </section>

      <p className="acct-legal">
        Sociafy is a product of GNIX Semiconductors Private Limited, 2TF, Satyam Complex 2, Sector Alpha II, Greater Noida, Uttar Pradesh 201310, India.
      </p>

      {/* ---------- Top up: pick a pack → see the total → Pay ---------- */}
      <Modal
        open={sheet?.kind === 'topup'}
        onClose={() => { if (busy !== 'topup') setSheet(null); }}
        title="Top up credits"
        footer={<>
          <Button onClick={() => setSheet(null)} disabled={busy === 'topup'}>Not now</Button>
          <Button
            variant="primary"
            busy={busy === 'topup'}
            disabled={!data?.billingConfigured}
            reason={PAYMENTS_DOWN}
            onClick={buyTopUp}
          >
            {busy === 'topup' ? 'Opening Razorpay…' : `Pay ${topup.charge}`}
          </Button>
        </>}
      >
        <p className="acct-sheet-p">Paid once. Credits never expire and land a few seconds after payment.</p>
        <div className="row" role="group" aria-label="Pack size">
          {PACKS.map((n) => (
            <button key={n} type="button" className="chip" aria-pressed={pack === n} onClick={() => setPack(n)}>
              {num(n)} credits
            </button>
          ))}
        </div>
        <div className="acct-sum">
          <div><span>{num(pack)} credits</span><span>{topup.approximate ? `${topup.display} · ${topup.charge}` : topup.charge}</span></div>
          <div className="acct-note">
            <span>incl. GST{tax.split === 'export' ? '' : ` (${tax.label})`}</span>
            <span>{inr(splitInclusive(topup.chargeMinor).taxMinor)}</span>
          </div>
          <div className="acct-note"><span>Buys ≈ {num(Math.floor(pack / REEL))} AI reels or {num(Math.floor(pack / IMAGE))} images</span><span /></div>
        </div>
        <p className="acct-note">
          Invoice to <b>{details?.legalName || 'your account (no company name yet)'}</b>
          {details?.gstin && <> · GSTIN <span className="mono">{details.gstin}</span></>}
          {' · '}<Link className="acct-link" href="/account/invoices?edit=1">Edit</Link>
        </p>
      </Modal>

      {/* ---------- Upgrade: show the prorated amount, then Razorpay ---------- */}
      <Modal
        open={sheet?.kind === 'upgrade' && !!sheetTier?.upgrade}
        onClose={() => { if (busy !== 'change') setSheet(null); }}
        title={`Upgrade to ${sheetTier?.label ?? ''}`}
        footer={<>
          <Button onClick={() => setSheet(null)} disabled={busy === 'change'}>Not now</Button>
          <Button variant="primary" busy={busy === 'change'} onClick={() => sheetTier && changeTier(sheetTier.tier)}>
            {busy === 'change' ? 'Opening Razorpay…' : <>Continue to Razorpay <span className="cost">{inr(sheetTier?.upgrade?.dueMinor ?? 0)}</span></>}
          </Button>
        </>}
      >
        {sheetTier?.upgrade && (
          <>
            <p className="acct-sheet-p">
              You pay the difference for the {daysLeft ?? 'remaining'} days left in this cycle. {sheetTier.label} starts once the payment goes through.
            </p>
            <div className="acct-sum">
              <div><span>Due today (prorated)</span><span>{inr(sheetTier.upgrade.dueMinor)}</span></div>
              <div className="acct-note"><span>incl. GST</span><span>{inr(splitInclusive(sheetTier.upgrade.dueMinor).taxMinor)}</span></div>
              <div><span>Credits added after payment</span><span>+{num(sheetTier.upgrade.creditsNow)}</span></div>
              <div><span>Then</span><span>{sheetTier.chargeMonthly} / month</span></div>
            </div>
            <p className="acct-note">Your plan changes only after Razorpay confirms the payment.</p>
          </>
        )}
      </Modal>

      {/* ---------- Downgrade: confirm, nothing charged ---------- */}
      <Modal
        open={sheet?.kind === 'down'}
        onClose={() => { if (busy !== 'change') setSheet(null); }}
        title={`Switch to ${sheetTier?.label ?? ''} on ${endLabel}?`}
        footer={<>
          <Button onClick={() => setSheet(null)} disabled={busy === 'change'}>Keep {current?.label}</Button>
          <Button variant="primary" busy={busy === 'change'} onClick={() => sheetTier && changeTier(sheetTier.tier)}>
            Switch on {endLabel}
          </Button>
        </>}
      >
        {sheetTier && (
          <>
            <p className="acct-sheet-p">
              You keep {current?.label} and every credit you have until {endLabel}. From then you get {num(sheetTier.credits)} credits
              a month for {sheetTier.chargeMonthly}. Nothing is charged today. Razorpay may email you to approve the new plan.
            </p>
            <div className="acct-sum">
              <div><span>{current?.label} until</span><span>{endLabel}</span></div>
              <div><span>Then {sheetTier.label}</span><span>{sheetTier.chargeMonthly} / mo</span></div>
              <div><span>Credits you have now</span><span>stay</span></div>
            </div>
          </>
        )}
      </Modal>

      {/* ---------- Cancel: calm, exact, Keep plan is the default ---------- */}
      <Modal
        open={sheet?.kind === 'cancel'}
        onClose={() => { if (busy !== 'cancel') setSheet(null); }}
        title={`Cancel your ${current?.label ?? ''} plan?`}
        footer={<>
          <Button busy={busy === 'cancel'} onClick={cancel}>{busy === 'cancel' ? 'Cancelling…' : `Cancel on ${endLabel}`}</Button>
          <Button variant="primary" onClick={() => setSheet(null)} disabled={busy === 'cancel'}>Keep plan</Button>
        </>}
      >
        <p className="acct-sheet-p">Nothing changes until <b>{endLabel}</b>. After that:</p>
        <div className="acct-sum">
          <div><span>Your {data ? num(data.balance) : ''} credits</span><span>stay usable</span></div>
          <div><span>Posts already scheduled</span><span>still go out</span></div>
          <div><span>Monthly credits and charges</span><span>stop</span></div>
          <div><span>Refund for this cycle</span><span>none</span></div>
        </div>
        <p className="acct-note">Changed your mind later? Pick a plan again after {endLabel}.</p>
      </Modal>
    </div>
  );
}

const label = (t: Tier) => t.charAt(0).toUpperCase() + t.slice(1);
