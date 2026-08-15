import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { profiles, TIER_CREDITS, type Tier } from '../../../lib/db/schema';
import { getBalance } from '../../../lib/credits/ledger';
import { env, isStubMode, geoCountry } from '../../../lib/env';
import { tierPriceView, type Currency } from '../../../lib/billing/pricing';

export const runtime = 'nodejs';

/**
 * GET /api/billing — snapshot of the user's billing state for the UI.
 */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    // Production is Cloudflare → nginx → Next (etc/nginx/sites-available/sociafy.conf),
    // which forwards CF-IPCountry; x-vercel-ip-country is never set there, so
    // reading it alone quoted every Indian customer in dollars. Vercel fallback
    // kept for preview deploys.
    const detectedCountry = geoCountry(req.headers);

    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    // DISPLAY ONLY — deliberately not written back to billing_country. On this
    // stack the geo header is client-supplied (nginx copies whatever arrives),
    // and this used to stamp it permanently on first visit. Nothing needs the
    // column: providerFor() ignores it (lib/billing/router.ts — everyone is
    // Razorpay/INR), and the currency a user actually chooses is persisted by
    // POST /api/billing/preferences, which is authenticated intent rather than
    // a header.

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
