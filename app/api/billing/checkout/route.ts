import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles, TIERS } from '../../../../lib/db/schema';
import { providerFor } from '../../../../lib/billing/router';

export const runtime = 'nodejs';

const bodySchema = z.object({ tier: z.enum(TIERS) });

/**
 * POST /api/billing/checkout — start a subscription checkout for the
 * requested tier. Returns a CheckoutHandoff the client opens (URL
 * redirect for Stripe, modal params for Razorpay).
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
    if (!profile) return jsonError('profile_not_found', 404);

    const provider = providerFor({
      paymentProvider: profile.paymentProvider as 'stripe' | 'razorpay' | null,
      billingCurrency: profile.billingCurrency as 'INR' | 'USD' | null,
      billingCountry: profile.billingCountry,
    });
    if (!provider) {
      return jsonError('billing_coming_soon', 503, {
        hint: 'USD billing via Stripe is coming soon. Use the "Pay in INR via Razorpay" option.',
      });
    }

    const handoff = await provider.startSubscription({ userId: user.id, tier: parsed.data.tier });
    return handoff;
  }, req);
}
