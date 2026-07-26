/**
 * Stripe implementation of BillingProvider — the USD path. Subscriptions
 * and top-ups both go through hosted Checkout Sessions, so we never touch
 * card data. Every flow returns a `redirect` handoff the client assigns to
 * window.location.
 *
 * Credit granting lives entirely in /api/stripe/webhook: this module only
 * creates the intent and tags it with the metadata that handler reads
 * (`sociafy_user_id`). Never grant here — Checkout can be abandoned after
 * the session is created.
 */

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { Tier } from '../../../db/schema';
import { profiles } from '../../../db/schema';
import { db } from '../../../db';
import { TIER_PRICING, TOPUP_PRICING } from '../../pricing';
import type { BillingProvider, CheckoutHandoff, TierChangeResult } from '../../provider';
import { env, isStubMode } from '../../../env';
import { getStripe, priceIdFor, tierForPriceId, ORDERED_TIERS } from '../../../stripe';
import { ensureStripeCustomer } from './customer';

/** True only when Stripe can actually complete a checkout. The router uses
 *  this to hand callers a clean 503 instead of letting a missing price id
 *  surface as an opaque 500 halfway through a purchase. */
export function stripeConfigured(): boolean {
  return !isStubMode.stripe() && ORDERED_TIERS.every((t) => !!priceIdFor(t));
}

const successUrl = () => `${env.appUrl}/billing?checkout=success`;
const cancelUrl = () => `${env.appUrl}/billing?checkout=canceled`;

class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe' as const;
  readonly currency = 'USD' as const;

  async startSubscription({ userId, tier }: { userId: string; tier: Tier }): Promise<CheckoutHandoff> {
    const priceId = priceIdFor(tier);
    if (!priceId) throw new Error(`STRIPE_PRICE_${tier.toUpperCase()} is not set`);

    const customerId = await ensureStripeCustomer(userId);
    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      // The webhook reads session.metadata.sociafy_user_id first; the
      // subscription copy keeps later renewal events attributable even if
      // the session is long gone.
      metadata: { sociafy_user_id: userId, tier, kind: 'subscription' },
      subscription_data: { metadata: { sociafy_user_id: userId, tier } },
      success_url: successUrl(),
      cancel_url: cancelUrl(),
      allow_promotion_codes: true,
    });

    return redirect(session);
  }

  async startTopUp({ userId, credits }: { userId: string; credits: number }): Promise<CheckoutHandoff> {
    if (credits <= 0 || credits % 1000 !== 0) {
      throw new Error('credits must be a positive multiple of 1000');
    }
    const packs = credits / 1000;
    const customerId = await ensureStripeCustomer(userId);

    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      // Inline price_data instead of a STRIPE_PRICE_TOPUP env var: the pack
      // price already lives in TOPUP_PRICING, and one source of truth beats
      // keeping a dashboard price in sync with it.
      line_items: [{
        quantity: packs,
        price_data: {
          currency: 'usd',
          unit_amount: TOPUP_PRICING.USD.amountMinor,
          product_data: { name: `Sociafy top-up — ${TOPUP_PRICING.USD.credits.toLocaleString()} credits` },
        },
      }],
      client_reference_id: userId,
      metadata: { sociafy_user_id: userId, kind: 'topup', credits: String(credits) },
      payment_intent_data: {
        metadata: { sociafy_user_id: userId, kind: 'topup', credits: String(credits) },
      },
      success_url: successUrl(),
      cancel_url: cancelUrl(),
    });

    return redirect(session);
  }

  async cancelSubscription({ userId }: { userId: string }): Promise<{ periodEnd: Date | null }> {
    const [row] = await db()
      .select({
        stripeSubscriptionId: profiles.stripeSubscriptionId,
        subscriptionCurrentPeriodEnd: profiles.subscriptionCurrentPeriodEnd,
      })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);

    const subId = row?.stripeSubscriptionId;
    if (!subId) throw new Error('no active stripe subscription');

    // cancel_at_period_end → user keeps credits until period_end, same
    // contract as the Razorpay cancel-at-cycle-end path.
    await getStripe().subscriptions.update(subId, { cancel_at_period_end: true });
    return { periodEnd: row.subscriptionCurrentPeriodEnd ?? null };
  }

  async changeTier({ userId, toTier }: { userId: string; toTier: Tier }): Promise<TierChangeResult> {
    const [row] = await db()
      .select({
        stripeSubscriptionId: profiles.stripeSubscriptionId,
        tier: profiles.tier,
      })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);

    if (!row?.stripeSubscriptionId) throw new Error('no active stripe subscription');
    const toPriceId = priceIdFor(toTier);
    if (!toPriceId) throw new Error(`STRIPE_PRICE_${toTier.toUpperCase()} is not set`);

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error('stripe subscription has no items');

    // Prefer the live price over our mirrored tier column — the sub is the
    // authority on what the customer is actually paying for.
    const fromTier = tierForPriceId(item.price?.id) ?? (row.tier as Tier);
    const toAmount = TIER_PRICING.USD[toTier].amountMinor;
    const fromAmount = TIER_PRICING.USD[fromTier].amountMinor;
    if (toAmount === fromAmount) throw new Error('toTier is the same as the current tier');

    if (toAmount > fromAmount) {
      // Upgrade: Stripe computes the proration and invoices it now. The
      // resulting customer.subscription.updated + invoice.paid webhooks
      // move the tier and grant credits — nothing to do locally.
      //
      // ponytail: the webhook grants a FULL month of the new tier on that
      // proration invoice, where Razorpay grants only the delta. Bounded
      // over-grant in the user's favour; fix belongs in the webhook's
      // invoice.paid branch (skip or delta when billing_reason ===
      // 'subscription_update'), not here.
      await stripe.subscriptions.update(row.stripeSubscriptionId, {
        items: [{ id: item.id, price: toPriceId }],
        proration_behavior: 'always_invoice',
      });
      return { kind: 'immediate', effectiveAt: new Date() };
    }

    // Downgrade: a subscription schedule lets Stripe itself swap the price
    // at period end, so the renewal invoice arrives at the new tier and the
    // existing webhook grants the right credits with no cron of our own.
    // (Razorpay's pending_tier_change_* columns are applied by the Razorpay
    // webhook only — reusing them here would strand the change forever.)
    const existing = typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id;
    const schedule = existing
      ? await stripe.subscriptionSchedules.retrieve(existing)
      : await stripe.subscriptionSchedules.create({ from_subscription: row.stripeSubscriptionId });

    const current = schedule.phases[0];
    if (!current?.end_date) throw new Error('cannot downgrade — missing period_end');

    await stripe.subscriptionSchedules.update(schedule.id, {
      // Hand the subscription back to normal billing once the phases run out.
      end_behavior: 'release',
      phases: [
        {
          items: [{ price: priceIdFor(fromTier) ?? item.price.id, quantity: 1 }],
          start_date: current.start_date,
          end_date: current.end_date,
        },
        { items: [{ price: toPriceId, quantity: 1 }] },
      ],
    });

    return { kind: 'scheduled', effectiveAt: new Date(current.end_date * 1000) };
  }
}

function redirect(session: Stripe.Checkout.Session): CheckoutHandoff {
  if (!session.url) throw new Error('stripe checkout session has no url');
  return { kind: 'redirect', url: session.url };
}

let _instance: StripeBillingProvider | null = null;
export function stripeProvider(): StripeBillingProvider {
  if (!_instance) _instance = new StripeBillingProvider();
  return _instance;
}
