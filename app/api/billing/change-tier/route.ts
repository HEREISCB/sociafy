import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles, TIERS } from '../../../../lib/db/schema';
import { providerFor } from '../../../../lib/billing/router';

export const runtime = 'nodejs';

const bodySchema = z.object({ toTier: z.enum(TIERS) });

/**
 * POST /api/billing/change-tier
 *
 * Upgrade or downgrade an active subscription. Provider decides
 * proration / scheduling per the spec §8.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;

    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    if (!profile || profile.subscriptionStatus !== 'active') {
      return jsonError('no_active_subscription', 400);
    }
    if (profile.tier === parsed.data.toTier) {
      return jsonError('same_tier', 400);
    }

    const provider = providerFor({
      paymentProvider: profile.paymentProvider as 'stripe' | 'razorpay' | null,
      billingCurrency: profile.billingCurrency as 'INR' | 'USD' | null,
      billingCountry: profile.billingCountry,
    });
    if (!provider) {
      return jsonError('billing_coming_soon', 503);
    }

    const result = await provider.changeTier({ userId: user.id, toTier: parsed.data.toTier });
    return result;
  }, req);
}

/**
 * DELETE /api/billing/change-tier
 *
 * Clear a pending tier change ("Cancel switch" button). Per spec §8.3 step 6,
 * this only clears the local flag — the underlying Razorpay cancellation is
 * one-way, so the caller must re-subscribe before period_end. Returns a
 * caveat the UI surfaces to the user.
 */
export async function DELETE(req: NextRequest) {
  return withUser(async (user) => {
    await db()
      .update(profiles)
      .set({ pendingTierChangeTo: null, pendingTierChangeAt: null, updatedAt: new Date() })
      .where(eq(profiles.id, user.id));

    return {
      cleared: true,
      caveat: 'Your Razorpay subscription will still end on its scheduled date. Re-subscribe before then to keep service uninterrupted.',
    };
  }, req);
}
