/**
 * Stripe wiring — single source of truth for client creation, price/tier
 * mapping, and helper conversions.
 *
 * Architecture choice: webhooks mirror Stripe state into our DB; the app
 * reads tier + period_end from `profiles` instead of hitting Stripe at
 * request time. This keeps the hot path local and avoids billing surprises
 * if Stripe is slow.
 */

import Stripe from 'stripe';
import { env } from './env';
import { TIERS, type Tier } from './db/schema';

let _client: Stripe | null = null;

/** Returns the Stripe SDK client. Throws if STRIPE_SECRET_KEY is unset —
 *  callers should pre-check via `isStubMode.stripe()` to surface a friendly
 *  503 rather than letting this throw. */
export function getStripe(): Stripe {
  if (_client) return _client;
  if (!env.stripe.secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  _client = new Stripe(env.stripe.secretKey, {
    // Pin the API version so a Stripe platform-wide upgrade can't silently
    // change response shapes under us.
    apiVersion: '2025-08-27.basil',
    appInfo: { name: 'sociafy', version: '1.0' },
  });
  return _client;
}

/** Map our tier → Stripe price ID. Used by /api/billing/checkout. */
export function priceIdFor(tier: Tier): string | null {
  switch (tier) {
    case 'starter':  return env.stripe.priceStarter;
    case 'pro':      return env.stripe.pricePro;
    case 'business': return env.stripe.priceBusiness;
  }
}

/** Reverse mapping: Stripe price ID → our tier. Used in webhook handlers
 *  to know which tier the user landed on after a Checkout / subscription
 *  update event. */
export function tierForPriceId(priceId: string | null | undefined): Tier | null {
  if (!priceId) return null;
  if (priceId === env.stripe.priceStarter)  return 'starter';
  if (priceId === env.stripe.pricePro)      return 'pro';
  if (priceId === env.stripe.priceBusiness) return 'business';
  return null;
}

/** Tier display copy for the UI. Keep here so the billing page and the
 *  topbar pill stay in sync. */
export const TIER_META: Record<Tier, { label: string; priceMonthly: string; tagline: string }> = {
  starter:  { label: 'Starter',  priceMonthly: '$30',  tagline: '2,000 credits / mo' },
  pro:      { label: 'Pro',      priceMonthly: '$80',  tagline: '6,000 credits / mo · Autopilot' },
  business: { label: 'Business', priceMonthly: '$299', tagline: '25,000 credits / mo · 1080p hero clips' },
};

/** All tiers in display order. */
export const ORDERED_TIERS: Tier[] = ['starter', 'pro', 'business'];

// Re-export for callers that only need the type.
export { TIERS };
