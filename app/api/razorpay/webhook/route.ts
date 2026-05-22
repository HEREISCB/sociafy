import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { env, isStubMode } from '../../../../lib/env';
import { TIER_CREDITS, type Tier } from '../../../../lib/db/schema';
import { applySubscriptionState } from '../../../../lib/billing/state';
import { grantIdempotent } from '../../../../lib/credits/ledger';
import { normalizeRazorpayStatus, type RazorpaySubscriptionStatus } from '../../../../lib/billing/providers/razorpay/status';

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
  const payment = (payload.payment as { entity: { id: string } } | undefined)?.entity;
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
  await grantIdempotent({
    userId,
    kind: 'monthly_grant',
    credits: TIER_CREDITS[tier],
    source: `rzp_sub:${sub.id}:${payment.id}`,
    meta: { reason: 'monthly_renewal', tier, subscriptionId: sub.id, paymentId: payment.id },
  });
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
  // For pure cancels this is a no-op beyond marking canceled. The
  // pending-tier-change handoff (downgrade) is wired in Task 18b that
  // reads pending_tier_change_to on profile and creates the new sub.
  // For Task 18 we just mirror state.
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

async function handlePaymentCaptured(payload: Record<string, unknown>) {
  const payment = (payload.payment as { entity: {
    id: string;
    notes?: { sociafy_user_id?: string; kind?: string; credits?: string; [k: string]: unknown };
  } } | undefined)?.entity;
  if (!payment) return;
  const userId = payment.notes?.sociafy_user_id;
  const kind = payment.notes?.kind;
  if (!userId) return;

  if (kind === 'topup') {
    const credits = Number(payment.notes?.credits ?? '0');
    if (credits <= 0) return;
    await grantIdempotent({
      userId,
      kind: 'topup',
      credits,
      source: `rzp_topup:${payment.id}`,
      meta: { reason: 'topup', paymentId: payment.id },
    });
  }
  // kind === 'upgrade_diff' handoff (cancel old sub + create new) is
  // handled in Task 18b.
}
