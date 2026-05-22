import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles } from '../../../../lib/db/schema';

export const runtime = 'nodejs';

const bodySchema = z.object({
  currency: z.enum(['INR', 'USD']),
});

/**
 * POST /api/billing/preferences
 *
 * Sets the user's billing_currency override. Locked once a subscription
 * is active — returns 409 with the active provider so the UI can surface
 * a "cancel first" message.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;

    const [profile] = await db()
      .select({ status: profiles.subscriptionStatus, provider: profiles.paymentProvider })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    if (profile?.status === 'active' && profile?.provider) {
      return jsonError('subscription_active', 409, {
        hint: 'Cancel your current subscription before changing currency.',
        provider: profile.provider,
      });
    }

    await db()
      .update(profiles)
      .set({ billingCurrency: parsed.data.currency, updatedAt: new Date() })
      .where(eq(profiles.id, user.id));

    return { currency: parsed.data.currency, stripeComingSoon: parsed.data.currency === 'USD' };
  }, req);
}
