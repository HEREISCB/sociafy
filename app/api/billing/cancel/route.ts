import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { profiles } from '../../../../lib/db/schema';
import { providerFor } from '../../../../lib/billing/router';

export const runtime = 'nodejs';

/**
 * POST /api/billing/cancel — cancel the active subscription at cycle end.
 * Credits remain usable until subscription_current_period_end.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    if (!profile || profile.subscriptionStatus !== 'active') {
      return jsonError('no_active_subscription', 400);
    }

    const provider = providerFor({
      paymentProvider: profile.paymentProvider as 'stripe' | 'razorpay' | null,
      billingCurrency: profile.billingCurrency as 'INR' | 'USD' | null,
      billingCountry: profile.billingCountry,
    });
    if (!provider) {
      return jsonError('billing_coming_soon', 503, { hint: 'Payments are not configured for your currency.' });
    }

    const result = await provider.cancelSubscription({ userId: user.id });
    return { periodEnd: result.periodEnd?.toISOString() ?? null };
  }, req);
}
