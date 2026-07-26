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
 *   checkout.session.completed  → first-purchase tier set + first month grant,
 *                                 or a mode:'payment' top-up grant
 *   invoice.paid                → full-month renewal grant (subscription_cycle)
 *                                 or upgrade delta grant (subscription_update)
 *   customer.subscription.updated → tier change or period_end update
 *   customer.subscription.deleted → mark canceled (credits stay until period_end)
 *
 * Idempotency: every grant row carries a `source` in meta, keyed on the
 * durable Stripe object (checkout session / invoice) rather than the event id
 * — one purchase can emit several events (completed +
 * async_payment_succeeded, invoice.paid + invoice.payment_succeeded) and the
 * event id differs between them, which would double-grant.
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
      // Delayed payment methods finish the session before the money lands;
      // this event re-delivers the same session once it's actually paid.
      case 'checkout.session.async_payment_succeeded':
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
  // Top-ups are mode:'payment' — they carry no subscription, so they must be
  // handled before the subscription lookup below or the card is charged and
  // no credits are ever granted.
  if (session.metadata?.kind === 'topup') {
    await handleTopUp(session, userId);
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
    // Keyed on the session, not the event: a session can emit both
    // `completed` and `async_payment_succeeded`.
    source: `stripe_checkout:${session.id}`,
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

/** One-off credit purchase. Mirrors the Razorpay `notes.kind === 'topup'`
 *  path in /api/razorpay/webhook: pure ledger grant, no tier or cycle change. */
async function handleTopUp(session: Stripe.Checkout.Session, userId: string) {
  // Never grant on an unpaid session — async methods complete the session
  // first and only later succeed (or fail).
  if (session.payment_status === 'unpaid') return;

  const credits = Number(session.metadata?.credits ?? '0');
  if (!Number.isFinite(credits) || credits <= 0) {
    console.warn('[stripe.webhook] topup session without credits metadata:', session.id);
    return;
  }

  await grantIdempotent({
    userId,
    kind: 'topup',
    credits,
    source: `stripe_topup:${session.id}`,
    meta: {
      reason: 'topup',
      sessionId: session.id,
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
    },
  });
}

async function handleInvoicePaid(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  // First invoice for a new sub is handled by checkout.session.completed —
  // skip it here to avoid double-granting.
  if (invoice.billing_reason === 'subscription_create') return;

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return;

  const userId = await resolveUserIdByCustomer(invoice.customer);
  if (!userId) return;

  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
  const tier = tierForPriceId(sub.items.data[0]?.price?.id);
  if (!tier) return;

  const isProration = invoice.billing_reason === 'subscription_update';
  // Must be read before applySubscriptionState overwrites profiles.tier —
  // it's the fallback for the delta below.
  const mirroredTier = isProration ? await mirroredTierOf(userId) : null;

  await applySubscriptionState({
    userId,
    provider: 'stripe',
    status: 'active',
    tier,
    periodEnd: subPeriodEnd(sub),
    providerSubscriptionId: subscriptionId,
  });

  if (isProration) {
    // Mid-cycle upgrade. The user already got this cycle's grant at the old
    // tier, so only the gap is owed — same policy as Razorpay's
    // `upgrade_diff` path. The billing anchor doesn't move on a proration,
    // so creditCycleStart stays put too.
    const fromTier = prorationFromTier(invoice, tier) ?? mirroredTier;
    const delta = fromTier ? TIER_CREDITS[tier] - TIER_CREDITS[fromTier] : 0;
    if (delta > 0) {
      await grantIdempotent({
        userId,
        kind: 'monthly_grant',
        credits: delta,
        source: `stripe_upgrade:${invoice.id}`,
        meta: { reason: 'upgrade_delta', fromTier, toTier: tier, subscriptionId, invoiceId: invoice.id },
      });
    }
    return;
  }

  // Only a real cycle rollover earns a full month. Anything else
  // (subscription_threshold, manual, …) already had its state mirrored above.
  if (invoice.billing_reason !== 'subscription_cycle') {
    console.warn('[stripe.webhook] invoice.paid with no grant policy:', invoice.billing_reason);
    return;
  }

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
  await clearPendingTierChangeIfApplied(userId, tier);
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

/** Subscription that generated an invoice. The API version we pin
 *  (2025-08-27.basil) moved this under `parent.subscription_details`; the
 *  root `subscription` only exists on pre-basil payloads, so an endpoint left
 *  on an older version keeps working. Reading only the root field meant every
 *  renewal returned early and granted nothing. */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const i = invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription };
  const fromParent = i.parent?.subscription_details?.subscription;
  const raw = fromParent ?? i.subscription;
  return typeof raw === 'string' ? raw : raw?.id;
}

/** Our mirrored tier column. */
async function mirroredTierOf(userId: string): Promise<Tier | null> {
  const [row] = await db()
    .select({ tier: profiles.tier })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return (row?.tier as Tier | undefined) ?? null;
}

/** Tier the customer was on before a proration invoice. Stripe puts the
 *  unused-time credit for the old price on the same invoice as the new
 *  price, so the line whose price maps to a different tier is the old one.
 *  Preferred over our mirrored column because customer.subscription.updated
 *  may have already landed and overwritten it — delivery order isn't
 *  guaranteed. */
function prorationFromTier(invoice: Stripe.Invoice, toTier: Tier): Tier | null {
  for (const line of invoice.lines?.data ?? []) {
    // basil moved the price off the line root and under `pricing`.
    const l = line as unknown as { pricing?: { price_details?: { price?: string } }; price?: { id?: string } };
    const t = tierForPriceId(l.pricing?.price_details?.price ?? l.price?.id);
    if (t && t !== toTier) return t;
  }
  return null;
}

/** A scheduled tier change has landed once the live subscription price is the
 *  one the banner promised. Clearing here is what makes it safe for the
 *  Stripe provider's changeTier to set these columns in the first place. */
async function clearPendingTierChangeIfApplied(userId: string, tier: Tier | null) {
  if (!tier) return;
  const [row] = await db()
    .select({ pendingTierChangeTo: profiles.pendingTierChangeTo })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  if (row?.pendingTierChangeTo !== tier) return;
  await db()
    .update(profiles)
    .set({ pendingTierChangeTo: null, pendingTierChangeAt: null, updatedAt: new Date() })
    .where(eq(profiles.id, userId));
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
