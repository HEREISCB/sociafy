import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { profiles, TIER_CREDITS, type Tier } from '../../../lib/db/schema';
import { getBalance } from '../../../lib/credits/ledger';
import { env, isStubMode, geoCountry } from '../../../lib/env';
import { tierPriceView, TIER_PRICING, type Currency } from '../../../lib/billing/pricing';
import { scheduledCancelAt } from '../../../lib/billing/cancel';
import { deltaCredits, proratedDiffMinor } from '../../../lib/billing/providers/razorpay/proration';

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
    const now = new Date();
    const cancelsAt = profile ? scheduledCancelAt(profile, now) : null;
    // Subscriptions ride on Razorpay Plans, which require the Subscriptions
    // product to be enabled on the merchant account. Until ops creates the 3
    // plans and pastes the IDs in env, the Subscribe buttons can't go anywhere
    // — show them as "Coming soon" and steer users to top-ups instead. Checked
    // for every currency now that non-India customers also ride Razorpay.
    const subscriptionsAvailable =
      !!(env.razorpay.planStarter && env.razorpay.planPro && env.razorpay.planBusiness);

    return {
      currentTier: tier,
      // profiles.tier defaults to 'starter' for every new account, paid or not,
      // so only an active subscription makes a plan "current" on this page.
      currentTierLabel: hasActiveSubscription ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'No plan',
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
      /** Cycle-end cancel we recorded; null once the webhook has landed. */
      cancelsAt: cancelsAt?.toISOString() ?? null,
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
          isCurrent: hasActiveSubscription && t === tier,
          // Read-only preview of what POST /api/billing/change-tier will charge:
          // the same proratedDiffMinor call with the same inputs, so the figure
          // can only shrink by the seconds between preview and click.
          upgrade: hasActiveSubscription && TIER_PRICING.INR[t].amountMinor > TIER_PRICING.INR[tier].amountMinor
            ? {
                dueMinor: proratedDiffMinor({
                  oldAmountMinor: TIER_PRICING.INR[tier].amountMinor,
                  newAmountMinor: TIER_PRICING.INR[t].amountMinor,
                  now,
                  periodStart: profile!.creditCycleStart,
                  periodEnd: profile!.subscriptionCurrentPeriodEnd ?? now,
                }),
                creditsNow: deltaCredits(tier, t),
              }
            : null,
        };
      }),
    };
  }, req);
}
