import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { profiles, TIER_CREDITS, type Tier } from '../../../lib/db/schema';
import { getBalance } from '../../../lib/credits/ledger';
import { isStubMode, devForcedCountry } from '../../../lib/env';
import { TIER_PRICING, formatPrice, type Currency } from '../../../lib/billing/pricing';

export const runtime = 'nodejs';

/**
 * GET /api/billing — snapshot of the user's billing state for the UI.
 */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    // Detect country from Vercel geo header (or dev override).
    const detectedCountry =
      req.headers.get('x-vercel-ip-country')?.toUpperCase()
      ?? devForcedCountry()
      ?? null;

    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    // Write-through: stamp billing_country on first visit, never overwrite.
    if (profile && !profile.billingCountry && detectedCountry) {
      await db()
        .update(profiles)
        .set({ billingCountry: detectedCountry, updatedAt: new Date() })
        .where(eq(profiles.id, user.id));
      profile.billingCountry = detectedCountry;
    }

    const tier = (profile?.tier ?? 'starter') as Tier;
    const balance = await getBalance(user.id);
    const isIndia = (profile?.billingCountry ?? detectedCountry) === 'IN';
    const currency: Currency = (profile?.billingCurrency as Currency | null)
      ?? (isIndia ? 'INR' : 'USD');
    const provider: 'razorpay' | 'stripe' | null = profile?.paymentProvider
      ?? (currency === 'INR' ? 'razorpay' : null);
    const hasActiveSubscription = profile?.subscriptionStatus === 'active';
    const canSwitchProvider = !hasActiveSubscription;

    return {
      currentTier: tier,
      currentTierLabel: tier.charAt(0).toUpperCase() + tier.slice(1),
      monthlyAllocation: TIER_CREDITS[tier],
      balance,
      subscriptionStatus: profile?.subscriptionStatus ?? null,
      subscriptionCurrentPeriodEnd: profile?.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
      stripeCustomerId: profile?.stripeCustomerId ?? null,
      razorpayCustomerId: profile?.razorpayCustomerId ?? null,
      hasActiveSubscription,
      billingConfigured: !isStubMode.razorpay(),
      currency,
      provider,
      isIndia,
      canSwitchProvider,
      pendingTierChange: profile?.pendingTierChangeTo ? {
        toTier: profile.pendingTierChangeTo,
        at: profile.pendingTierChangeAt?.toISOString() ?? null,
      } : null,
      tiers: (['starter', 'pro', 'business'] as Tier[]).map((t) => ({
        tier: t,
        label: t.charAt(0).toUpperCase() + t.slice(1),
        priceMonthly: formatPrice(currency, t),
        amountMinor: TIER_PRICING[currency][t].amountMinor,
        credits: TIER_CREDITS[t],
        isCurrent: t === tier,
      })),
    };
  }, req);
}
