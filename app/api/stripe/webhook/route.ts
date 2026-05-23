import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db } from '../../../../lib/db';
import { profiles, activityLog, TIER_CREDITS, type Tier } from '../../../../lib/db/schema';
import { isStubMode, env } from '../../../../lib/env';
import { getStripe, tierForPriceId } from '../../../../lib/stripe';
import { grantIdempotent } from '../../../../lib/credits/ledger';
import { applySubscriptionState } from '../../../../lib/billing/state';

export const runtime = 'nodejs';
// Stripe needs the raw body to verify the signature. Next.js App Router
// already gives us that via `req.text()` — no special body parser config
// like the Pages router needed.

/**
 * POST /api/stripe/webhook
 *
 * Signature-verified Stripe webhook. Mirrors subscription state into our
 * profiles + credit_ledger tables:
 *
 *   checkout.session.completed  → first-purchase tier set + first month grant
 *   invoice.paid                → renewal grant (idempotent via invoice id)
 *   customer.subscription.updated → tier change or period_end update
 *   customer.subscription.deleted → mark canceled (credits stay until period_end)
 *
 * Idempotency: every grant row carries the source event id in meta. Before
 * inserting a grant we check whether a row with that source already exists
 * — Stripe replays webhooks on transient failures, and we must not double-grant.
 */
export async function POST(req: NextRequest) {
  if (isStubMode.stripe()) {
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 });
  }
  const body = await req.text();

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, env.stripe.webhookSecret ?? '');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe.webhook] signature verification failed:', msg);
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event);
        break;
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        await handleInvoicePaid(event);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event);
        break;
      default:
        // No-op for events we don't care about — Stripe still gets a 2xx.
        break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stripe.webhook] handler for ${event.type} failed:`, msg);
    // Return 500 so Stripe retries. The signature already verified, so
    // this is a real downstream failure (db, etc).
    return NextResponse.json({ error: 'handler_failed', detail: msg }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}

// =====================================================
// Event handlers
// =====================================================

async function handleCheckoutCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  const userId =
    (session.metadata?.sociafy_user_id as string | undefined) ||
    (await resolveUserIdByCustomer(session.customer));
  if (!userId) {
    console.warn('[stripe.webhook] checkout.session.completed: no userId resolution');
    return;
  }
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  if (!subscriptionId) return;

  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price'],
  });
  const item = sub.items.data[0];
  const tier = tierForPriceId(item?.price?.id);
  if (!tier) {
    console.warn('[stripe.webhook] checkout.session.completed: unknown price', item?.price?.id);
    return;
  }

  await applySubscriptionState({
    userId,
    provider: 'stripe',
    status: 'active',
    tier,
    periodEnd: subPeriodEnd(sub),
    providerCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? undefined,
    providerSubscriptionId: subscriptionId,
  });
  await db()
    .update(profiles)
    .set({ creditCycleStart: new Date() })
    .where(eq(profiles.id, userId));

  await grantIdempotent({
    userId,
    kind: 'monthly_grant',
    credits: TIER_CREDITS[tier],
    source: `checkout:${event.id}`,
    meta: {
      reason: 'first_purchase',
      tier,
      subscriptionId,
      sessionId: session.id,
    },
  });

  await db().insert(activityLog).values({
    userId,
    kind: 'agent_enabled',
    title: `Upgraded to ${tier.charAt(0).toUpperCase() + tier.slice(1)}`,
    body: `Welcome! ${TIER_CREDITS[tier].toLocaleString()} credits added to your balance.`,
    meta: { tier, subscriptionId },
  });
}

async function handleInvoicePaid(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  // First invoice for a new sub is handled by checkout.session.completed —
  // skip it here to avoid double-granting.
  if (invoice.billing_reason === 'subscription_create') return;

  const inv = invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription };
  const subscriptionId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
  if (!subscriptionId) return;

  const userId = await resolveUserIdByCustomer(invoice.customer);
  if (!userId) return;

  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
  const tier = tierForPriceId(sub.items.data[0]?.price?.id);
  if (!tier) return;

  await applySubscriptionState({
    userId,
    provider: 'stripe',
    status: 'active',
    tier,
    periodEnd: subPeriodEnd(sub),
    providerSubscriptionId: subscriptionId,
  });
  await db()
    .update(profiles)
    .set({ creditCycleStart: new Date() })
    .where(eq(profiles.id, userId));

  await grantIdempotent({
    userId,
    kind: 'monthly_grant',
    credits: TIER_CREDITS[tier],
    source: `invoice:${invoice.id}`,
    meta: {
      reason: 'monthly_renewal',
      tier,
      subscriptionId,
      invoiceId: invoice.id,
    },
  });
}

async function handleSubscriptionUpdated(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;
  const userId = await resolveUserIdByCustomer(sub.customer);
  if (!userId) return;
  const tier = tierForPriceId(sub.items.data[0]?.price?.id);

  await applySubscriptionState({
    userId,
    provider: 'stripe',
    status: normalizeStripeStatus(sub.status),
    tier: tier ?? null,
    periodEnd: subPeriodEnd(sub),
    providerSubscriptionId: sub.id,
  });
}

async function handleSubscriptionDeleted(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;
  const userId = await resolveUserIdByCustomer(sub.customer);
  if (!userId) return;
  // We keep the credits already granted until period_end. The user is
  // effectively on "paid until X, then no more grants". A future cron can
  // flip tier back to a "free" tier when the period ends — not in scope today.
  await applySubscriptionState({
    userId,
    provider: 'stripe',
    status: 'canceled',
    tier: null,
    periodEnd: subPeriodEnd(sub),
  });

  await db().insert(activityLog).values({
    userId,
    kind: 'agent_disabled',
    title: 'Subscription canceled',
    body: 'Your subscription will end at the current period. Credits remain usable until then.',
    meta: { subscriptionId: sub.id, periodEnd: subPeriodEnd(sub)?.toISOString() ?? null },
  });
}

// =====================================================
// Helpers
// =====================================================

/** Pull the period_end timestamp off a subscription robustly. Stripe's TS
 *  types occasionally lag the actual API response shape — fall back to
 *  reading from item-level fields. */
function subPeriodEnd(sub: Stripe.Subscription): Date | null {
  const s = sub as unknown as { current_period_end?: number; items?: { data?: Array<{ current_period_end?: number }> } };
  const ts = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  if (typeof ts === 'number') return new Date(ts * 1000);
  return null;
}

async function resolveUserIdByCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): Promise<string | null> {
  if (!customer) return null;
  const customerId = typeof customer === 'string' ? customer : customer.id;
  if (!customerId) return null;
  const [row] = await db()
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.stripeCustomerId, customerId))
    .limit(1);
  if (row) return row.id;
  // Fallback: look up by metadata on the customer (in case the profile
  // wasn't linked yet).
  try {
    const stripe = getStripe();
    const c = await stripe.customers.retrieve(customerId);
    if (!c.deleted && c.metadata?.sociafy_user_id) {
      return c.metadata.sociafy_user_id;
    }
  } catch { /* okay */ }
  return null;
}

/** Map Stripe subscription status strings to our NormalizedStatus vocabulary. */
function normalizeStripeStatus(status: Stripe.Subscription['status']): import('../../../../lib/billing/providers/razorpay/status').NormalizedStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
    case 'incomplete_expired':
    default:
      return 'incomplete';
  }
}

// Unused-import shim. `Tier` is referenced in type-only positions through
// TIER_CREDITS keys; lint can't always see through that.
void (null as unknown as Tier);
