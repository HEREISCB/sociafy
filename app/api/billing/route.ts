import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { profiles, TIER_CREDITS, type Tier } from '../../../lib/db/schema';
import { getBalance } from '../../../lib/credits/ledger';
import { isStubMode } from '../../../lib/env';
import { TIER_META } from '../../../lib/stripe';

export const runtime = 'nodejs';

/**
 * GET /api/billing
 *
 * Snapshot of the user's current billing state: tier, subscription status,
 * renewal date, balance, allocation, and the available tier catalog with
 * Stripe-priced upgrade targets.
 */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    const tier = (profile?.tier ?? 'starter') as Tier;
    const balance = await getBalance(user.id);

    return {
      currentTier: tier,
      currentTierLabel: TIER_META[tier].label,
      monthlyAllocation: TIER_CREDITS[tier],
      balance,
      subscriptionStatus: profile?.subscriptionStatus ?? null,
      subscriptionCurrentPeriodEnd: profile?.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
      stripeCustomerId: profile?.stripeCustomerId ?? null,
      hasActiveSubscription:
        !!profile?.stripeSubscriptionId && profile?.subscriptionStatus === 'active',
      billingConfigured: !isStubMode.stripe(),
      // The three tiers — UI will render upgrade/downgrade CTAs per row.
      tiers: (['starter', 'pro', 'business'] as Tier[]).map((t) => ({
        tier: t,
        label: TIER_META[t].label,
        priceMonthly: TIER_META[t].priceMonthly,
        tagline: TIER_META[t].tagline,
        credits: TIER_CREDITS[t],
        isCurrent: t === tier,
      })),
    };
  }, req);
}
