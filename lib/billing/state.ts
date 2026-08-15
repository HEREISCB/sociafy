/**
 * Provider-agnostic profile state mirror. Called by both Stripe and
 * Razorpay webhooks after they parse provider-specific events into a
 * normalized shape. Routes the right columns based on `provider`.
 */

import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db';
import { profiles, type Tier } from '../db/schema';
import type { NormalizedStatus } from './providers/razorpay/status';

/**
 * Identity guard. A status-only event (`tier: null` — updated / cancelled /
 * halted / paused) carries no claim to be the profile's current plan, so it is
 * applied only when it names the subscription the profile already points at
 * (or the profile points at nothing yet). Without this, the
 * `subscription.cancelled` webhook for the subscription an upgrade just
 * superseded wiped the freshly-activated one and the customer lost the plan
 * they had paid for.
 *
 * Writes that DO carry a tier (activated / charged / upgrade) are authoritative
 * — they are how a first subscription, an upgrade's new subscription, and a
 * re-subscribe after cancelling all land, so they are never guarded.
 *
 * ponytail: identity guard only, no event-ordering. A redelivered
 * `subscription.activated` for the profile's own, since-cancelled subscription
 * still re-activates it (grantIdempotent still blocks the duplicate credits).
 * Add an event-timestamp column if Razorpay replay ordering ever bites.
 */
export async function applySubscriptionState(args: {
  userId: string;
  provider: 'stripe' | 'razorpay';
  status: NormalizedStatus;
  tier: Tier | null;
  periodEnd: Date | null;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
}): Promise<void> {
  const update: Record<string, unknown> = {
    subscriptionStatus: args.status,
    subscriptionCurrentPeriodEnd: args.periodEnd,
    paymentProvider: args.provider,
    updatedAt: new Date(),
  };
  if (args.tier) update.tier = args.tier;

  if (args.provider === 'razorpay') {
    if (args.providerCustomerId)    update.razorpayCustomerId    = args.providerCustomerId;
    if (args.providerSubscriptionId) update.razorpaySubscriptionId = args.providerSubscriptionId;
  } else {
    if (args.providerCustomerId)    update.stripeCustomerId    = args.providerCustomerId;
    if (args.providerSubscriptionId) update.stripeSubscriptionId = args.providerSubscriptionId;
  }

  // Guard in the WHERE clause, not a read-then-write: it stays atomic, and a
  // superseded event simply matches zero rows.
  const subCol = args.provider === 'razorpay'
    ? profiles.razorpaySubscriptionId
    : profiles.stripeSubscriptionId;
  const where = args.tier === null && args.providerSubscriptionId
    ? and(
        eq(profiles.id, args.userId),
        or(isNull(subCol), eq(subCol, args.providerSubscriptionId)),
      )
    : eq(profiles.id, args.userId);

  await db().update(profiles).set(update).where(where);
}
