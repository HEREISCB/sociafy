import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles } from '../../../../lib/db/schema';
import { providerFor } from '../../../../lib/billing/router';

export const runtime = 'nodejs';

const bodySchema = z.object({
  credits: z.number().int().min(1000).max(100000)
    .refine((n) => n % 1000 === 0, 'credits must be a multiple of 1000'),
});

/**
 * POST /api/billing/topup — one-time credit pack purchase. Charged in INR via
 * Razorpay for every customer; see lib/billing/router.ts.
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
    // Only reachable when Razorpay credentials are missing.
    if (!provider) return jsonError('billing_coming_soon', 503, {
      hint: 'Payments are not configured yet. Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.',
    });

    const handoff = await provider.startTopUp({ userId: user.id, credits: parsed.data.credits });
    return handoff;
  }, req);
}
