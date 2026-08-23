import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { env, isStubMode } from '../../../../lib/env';
import { TIER_CREDITS, type Tier } from '../../../../lib/db/schema';
import { profiles } from '../../../../lib/db/schema';
import { db } from '../../../../lib/db';
import { applySubscriptionState } from '../../../../lib/billing/state';
import { grantIdempotent } from '../../../../lib/credits/ledger';
import { normalizeRazorpayStatus, type RazorpaySubscriptionStatus } from '../../../../lib/billing/providers/razorpay/status';
import { getRazorpay, razorpayPlanIdFor } from '../../../../lib/billing/providers/razorpay/client';
import { topupPriceView, TIER_PRICING } from '../../../../lib/billing/pricing';
import { deltaCredits } from '../../../../lib/billing/providers/razorpay/proration';
import { issueInvoice } from '../../../../lib/billing/zoho/invoice';

export const runtime = 'nodejs';

/**
 * Razorpay webhook. Mirrors subscription state into profiles and writes
 * idempotent credit grants into credit_ledger. Signature verification is
 * mandatory before any DB write.
 *
 * Events handled: subscription.activated, subscription.charged,
 * subscription.updated, subscription.cancelled, subscription.completed,
 * subscription.halted, subscription.paused, payment.captured.
 *
 * Idempotency: meta.source on every grant carries the Razorpay event /
 * payment id so retried deliveries do not double-credit.
 */
export async function POST(req: NextRequest) {
  if (isStubMode.razorpay()) {
    return NextResponse.json({ error: 'razorpay_not_configured' }, { status: 503 });
  }

  const sig = req.headers.get('x-razorpay-signature');
  if (!sig) return NextResponse.json({ error: 'missing_signature' }, { status: 400 });

  const body = await req.text();
  const expected = crypto
    .createHmac('sha256', env.razorpay.webhookSecret!)
    .update(body)
    .digest('hex');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  let event: { event: string; payload: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    switch (event.event) {
      case 'subscription.activated': await handleSubActivated(event.payload); break;
      case 'subscription.charged':   await handleSubCharged(event.payload);   break;
      case 'subscription.updated':   await handleSubUpdated(event.payload);   break;
      case 'subscription.cancelled': await handleSubCancelled(event.payload); break;
      case 'subscription.completed': await handleSubCompleted(event.payload); break;
      case 'subscription.halted':
      case 'subscription.paused':    await handleSubPastDue(event.payload);   break;
      case 'payment.captured':       await handlePaymentCaptured(event.payload); break;
      default: /* 2xx no-op */
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[razorpay.webhook] ${event.event} failed:`, msg);
    return NextResponse.json({ error: 'handler_failed', detail: msg }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

type SubEntity = {
  id: string;
  status: RazorpaySubscriptionStatus;
  plan_id: string;
  current_end?: number;
  customer_id?: string;
  notes?: { sociafy_user_id?: string; tier?: Tier; [k: string]: unknown };
};

function readSub(payload: Record<string, unknown>): SubEntity {
  const sub = (payload.subscription as { entity: SubEntity } | undefined)?.entity;
  if (!sub) throw new Error('payload.subscription.entity missing');
  return sub;
}

function tierFromPlanId(planId: string): Tier | null {
  if (planId === env.razorpay.planStarter)  return 'starter';
  if (planId === env.razorpay.planPro)      return 'pro';
  if (planId === env.razorpay.planBusiness) return 'business';
  return null;
}

function tsToDate(ts: number | undefined): Date | null {
  return typeof ts === 'number' ? new Date(ts * 1000) : null;
}

async function handleSubActivated(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  const tier = sub.notes?.tier ?? tierFromPlanId(sub.plan_id);
  if (!userId || !tier) return;

  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: normalizeRazorpayStatus(sub.status),
    tier,
    periodEnd: tsToDate(sub.current_end),
    providerCustomerId: sub.customer_id,
    providerSubscriptionId: sub.id,
  });
  await db()
    .update(profiles)
    .set({ creditCycleStart: new Date() })
    .where(eq(profiles.id, userId));
  await grantIdempotent({
    userId,
    kind: 'monthly_grant',
    credits: TIER_CREDITS[tier],
    source: `rzp_sub:${sub.id}:activated`,
    meta: { reason: 'first_purchase', tier, subscriptionId: sub.id },
  });
}

async function handleSubCharged(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const payment = (payload.payment as { entity: { id: string; amount?: number } } | undefined)?.entity;
  const userId = sub.notes?.sociafy_user_id;
  const tier = sub.notes?.tier ?? tierFromPlanId(sub.plan_id);
  if (!userId || !tier || !payment) return;

  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: 'active',
    tier,
    periodEnd: tsToDate(sub.current_end),
    providerSubscriptionId: sub.id,
  });
  await db()
    .update(profiles)
    .set({ creditCycleStart: new Date() })
    .where(eq(profiles.id, userId));
  await grantIdempotent({
    userId,
    kind: 'monthly_grant',
    credits: TIER_CREDITS[tier],
    source: `rzp_sub:${sub.id}:${payment.id}`,
    meta: { reason: 'monthly_renewal', tier, subscriptionId: sub.id, paymentId: payment.id },
  });

  // subscription.charged is the only subscription event that carries a real
  // payment, so it is the only one that gets an invoice. Invoicing on
  // `activated` too would raise a second document for the same rupee.
  await invoice({
    userId,
    kind: 'subscription',
    source: `rzp_sub:${sub.id}:${payment.id}`,
    grossMinor: Number(payment.amount) || TIER_PRICING.INR[tier].amountMinor,
    description: `Sociafy ${tier} plan — monthly subscription`,
    providerPaymentId: payment.id,
    meta: { tier, subscriptionId: sub.id },
  });
}

/**
 * Raise the GST invoice for a captured payment. Deliberately swallows
 * everything: the money has moved and the credits are already granted, so a
 * Zoho outage must not 500 this webhook into a Razorpay retry storm. Failed
 * rows sit in `invoices` and the hourly reissue-invoices cron picks them up.
 */
async function invoice(args: Parameters<typeof issueInvoice>[0]) {
  try {
    const r = await issueInvoice(args);
    if (!r.ok) console.error(`[razorpay.webhook] invoice ${args.source} deferred: ${r.error}`);
  } catch (e) {
    console.error(
      `[razorpay.webhook] invoice ${args.source} threw:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function handleSubUpdated(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  if (!userId) return;
  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: normalizeRazorpayStatus(sub.status),
    tier: null,
    periodEnd: tsToDate(sub.current_end),
    providerSubscriptionId: sub.id,
  });
}

async function handleSubCancelled(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  if (!userId) return;
  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: 'canceled',
    tier: null,
    periodEnd: tsToDate(sub.current_end),
    providerSubscriptionId: sub.id,
  });
}

async function handleSubCompleted(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  if (!userId) return;

  const [row] = await db()
    .select({
      pendingTierChangeTo: profiles.pendingTierChangeTo,
      razorpayCustomerId: profiles.razorpayCustomerId,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  const pendingTo = row?.pendingTierChangeTo as Tier | null;
  if (pendingTo && row?.razorpayCustomerId) {
    const planId = razorpayPlanIdFor(pendingTo);
    if (planId) {
      const next = await getRazorpay().subscriptions.create({
        plan_id: planId,
        customer_id: row.razorpayCustomerId,
        total_count: 120,
        customer_notify: 1,
        notes: { sociafy_user_id: userId, tier: pendingTo },
      } as Parameters<ReturnType<typeof getRazorpay>['subscriptions']['create']>[0]);

      await applySubscriptionState({
        userId,
        provider: 'razorpay',
        status: 'incomplete',
        tier: pendingTo,
        periodEnd: null,
        providerSubscriptionId: next.id,
      });
      await db()
        .update(profiles)
        .set({ pendingTierChangeTo: null, pendingTierChangeAt: null, updatedAt: new Date() })
        .where(eq(profiles.id, userId));
      return;
    }
  }

  // No pending change → behave like cancel.
  await handleSubCancelled(payload);
}

async function handleSubPastDue(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  if (!userId) return;
  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: 'past_due',
    tier: null,
    periodEnd: tsToDate(sub.current_end),
    providerSubscriptionId: sub.id,
  });
}

type OrderNotes = {
  sociafy_user_id?: string;
  kind?: string;
  credits?: string;
  from_tier?: Tier;
  to_tier?: Tier;
  old_sub_id?: string;
  [k: string]: unknown;
};

/**
 * `payment.captured` — the only handler that turns money into credits.
 *
 * Everything it acts on comes from the ORDER we created server-side, fetched
 * fresh from Razorpay by `payment.order_id`. The payment's own notes are
 * attacker-controlled: `startTopUp` hands that same object to the browser,
 * which passes it into the Checkout constructor, so a user could name any
 * recipient and any credit quantity. Reading the order instead means the
 * recipient and the quantity are ours, and the ownership check is implicit —
 * the order's notes name the user the order was created for.
 *
 * The paid amount is then checked against the price table, so a captured
 * partial payment (Razorpay allows those) never buys a full pack either.
 */
async function handlePaymentCaptured(payload: Record<string, unknown>) {
  const payment = (payload.payment as { entity: {
    id: string;
    amount?: number;
    order_id?: string;
  } } | undefined)?.entity;
  if (!payment?.order_id) return;

  let order: { amount?: number | string; notes?: OrderNotes };
  try {
    order = await getRazorpay().orders.fetch(payment.order_id);
  } catch (e) {
    // Never grant on an order we could not read. Razorpay retries the webhook.
    console.error(
      `[razorpay.webhook] payment.captured ${payment.id}: orders.fetch(${payment.order_id}) failed — NOT granting:`,
      e instanceof Error ? e.message : String(e),
    );
    return;
  }

  const notes: OrderNotes = order.notes ?? {};
  const userId = notes.sociafy_user_id;
  if (!userId) return;

  const paidMinor = Number(payment.amount);
  if (Number(order.amount) !== paidMinor) {
    console.error(
      `[razorpay.webhook] payment.captured ${payment.id}: paid ${paidMinor} but order ${payment.order_id} is ${order.amount} — NOT granting`,
    );
    return;
  }

  if (notes.kind === 'topup') {
    const credits = Number(notes.credits ?? '0');
    if (!Number.isInteger(credits) || credits <= 0) return;
    // Price table, not the order, decides what this many credits costs.
    const expectedMinor = topupPriceView('INR', credits).chargeMinor;
    if (paidMinor !== expectedMinor) {
      console.error(
        `[razorpay.webhook] payment.captured ${payment.id}: ${credits} credits cost ${expectedMinor} but ${paidMinor} was paid (order ${payment.order_id}, user ${userId}) — NOT granting`,
      );
      return;
    }
    await grantIdempotent({
      userId,
      kind: 'topup',
      credits,
      source: `rzp_topup:${payment.id}`,
      meta: { reason: 'topup', paymentId: payment.id },
    });
    await invoice({
      userId,
      kind: 'topup',
      source: `rzp_topup:${payment.id}`,
      grossMinor: paidMinor,
      description: `Sociafy credits top-up — ${credits.toLocaleString('en-IN')} credits`,
      providerPaymentId: payment.id,
      meta: { credits },
    });
    return;
  }

  if (notes.kind === 'upgrade_diff' && notes.from_tier && notes.to_tier && notes.old_sub_id) {
    const [row] = await db()
      .select({ razorpayCustomerId: profiles.razorpayCustomerId })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    if (!row?.razorpayCustomerId) return;

    const planId = razorpayPlanIdFor(notes.to_tier);
    if (!planId) return;

    try { await getRazorpay().subscriptions.cancel(notes.old_sub_id, false); } catch { /* okay */ }

    const next = await getRazorpay().subscriptions.create({
      plan_id: planId,
      customer_id: row.razorpayCustomerId,
      total_count: 120,
      customer_notify: 1,
      notes: { sociafy_user_id: userId, tier: notes.to_tier },
    } as Parameters<ReturnType<typeof getRazorpay>['subscriptions']['create']>[0]);

    await applySubscriptionState({
      userId,
      provider: 'razorpay',
      status: 'active',
      tier: notes.to_tier,
      periodEnd: null,
      providerSubscriptionId: next.id,
    });

    await invoice({
      userId,
      kind: 'upgrade',
      source: `rzp_upgrade:${payment.id}`,
      grossMinor: paidMinor,
      description: `Sociafy plan upgrade ${notes.from_tier} → ${notes.to_tier} — prorated`,
      providerPaymentId: payment.id,
      meta: { fromTier: notes.from_tier, toTier: notes.to_tier },
    });

    const delta = deltaCredits(notes.from_tier, notes.to_tier);
    if (delta > 0) {
      await grantIdempotent({
        userId,
        kind: 'monthly_grant',
        credits: delta,
        source: `rzp_upgrade:${payment.id}`,
        meta: { reason: 'upgrade_delta', fromTier: notes.from_tier, toTier: notes.to_tier, paymentId: payment.id },
      });
    }
  }
}
