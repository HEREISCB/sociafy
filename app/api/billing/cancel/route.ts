import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { profiles } from '../../../../lib/db/schema';
import { providerFor } from '../../../../lib/billing/router';
import { scheduledCancelAt } from '../../../../lib/billing/cancel';

export const runtime = 'nodejs';

/**
 * POST /api/billing/cancel — cancel the active subscription at cycle end.
 * Credits remain usable; they never expire.
 *
 * Records the cancel locally (lib/billing/cancel.ts) so the page can say
 * "Ends {date}" straight away instead of waiting for the end-of-cycle webhook.
 * Idempotent: a second call answers with the recorded date and does not call
 * Razorpay again.
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

    const already = scheduledCancelAt(profile, new Date());
    if (already) return { periodEnd: already.toISOString() };

    const mark = async (at: Date | null) => {
      if (!at) return;
      await db()
        .update(profiles)
        .set({ pendingTierChangeTo: null, pendingTierChangeAt: at, updatedAt: new Date() })
        .where(eq(profiles.id, user.id));
    };

    // A scheduled downgrade already cancelled the Razorpay subscription at cycle
    // end (that is how a downgrade works). Cancelling now only drops the
    // re-subscribe to the lower tier; a second Razorpay cancel would just error.
    if (profile.pendingTierChangeTo) {
      const at = profile.pendingTierChangeAt ?? profile.subscriptionCurrentPeriodEnd;
      await mark(at);
      return { periodEnd: at?.toISOString() ?? null };
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
    // ponytail: no period end on record → nothing to mark, and the page keeps
    // offering Cancel until the webhook lands. Only happens right after an upgrade.
    await mark(result.periodEnd);
    return { periodEnd: result.periodEnd?.toISOString() ?? null };
  }, req);
}
