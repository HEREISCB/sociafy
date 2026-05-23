/**
 * Provider-agnostic profile state mirror. Called by both Stripe and
 * Razorpay webhooks after they parse provider-specific events into a
 * normalized shape. Routes the right columns based on `provider`.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { profiles, type Tier } from '../db/schema';
import type { NormalizedStatus } from './providers/razorpay/status';

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

  await db().update(profiles).set(update).where(eq(profiles.id, args.userId));
}
