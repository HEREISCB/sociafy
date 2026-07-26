import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { profiles, TIER_CREDITS, type Tier } from '../../../lib/db/schema';
import { getBalance } from '../../../lib/credits/ledger';
import { env, isStubMode, devForcedCountry } from '../../../lib/env';
import { tierPriceView, type Currency } from '../../../lib/billing/pricing';

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
    // Everyone is charged by Razorpay in INR — Stripe is parked (see
    // lib/billing/router.ts), so the provider no longer depends on currency.
    const provider = 'razorpay' as const;
    const hasActiveSubscription = profile?.subscriptionStatus === 'active';
    const canSwitchProvider = !hasActiveSubscription;
    // Subscriptions ride on Razorpay Plans, which require the Subscriptions
    // product to be enabled on the merchant account. Until ops creates the 3
    // plans and pastes the IDs in env, the Subscribe buttons can't go anywhere
    // — show them as "Coming soon" and steer users to top-ups instead. Checked
    // for every currency now that non-India customers also ride Razorpay.
    const subscriptionsAvailable =
      !!(env.razorpay.planStarter && env.razorpay.planPro && env.razorpay.planBusiness);

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
      subscriptionsAvailable,
      currency,
      provider,
      isIndia,
      canSwitchProvider,
      pendingTierChange: profile?.pendingTierChangeTo ? {
        toTier: profile.pendingTierChangeTo,
        at: profile.pendingTierChangeAt?.toISOString() ?? null,
      } : null,
      tiers: (['starter', 'pro', 'business'] as Tier[]).map((t) => {
        const p = tierPriceView(currency, t);
        return {
          tier: t,
          label: t.charAt(0).toUpperCase() + t.slice(1),
          // Local approximation for display; `chargeMonthly` is what we bill.
          priceMonthly: p.display,
          chargeMonthly: p.charge,
          priceApproximate: p.approximate,
          amountMinor: p.chargeMinor,
          credits: TIER_CREDITS[t],
          isCurrent: t === tier,
        };
      }),
    };
  }, req);
}
