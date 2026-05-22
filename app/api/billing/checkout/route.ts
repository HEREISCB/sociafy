import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { currentUser } from '@clerk/nextjs/server';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles, TIERS } from '../../../../lib/db/schema';
import { isStubMode } from '../../../../lib/env';
import { getStripe, priceIdFor, TIER_META } from '../../../../lib/stripe';
import { absoluteUrl } from '../../../../lib/url';

export const runtime = 'nodejs';

const bodySchema = z.object({
  tier: z.enum(TIERS),
});

/**
 * POST /api/billing/checkout
 *
 * Creates (or reuses) the user's Stripe Customer and opens a Checkout
 * session for the requested tier's monthly subscription. Returns the
 * Stripe-hosted URL — client redirects to it.
 *
 * Webhook handles the post-payment state mirror; this route does NOT
 * touch profiles.tier itself.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.stripe()) {
      return jsonError('billing_not_configured', 503, {
        hint: 'Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and the three STRIPE_PRICE_* env vars.',
      });
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;
    const { tier } = parsed.data;

    const priceId = priceIdFor(tier);
    if (!priceId) {
      return jsonError('price_not_configured', 503, {
        hint: `STRIPE_PRICE_${tier.toUpperCase()} is not set.`,
      });
    }

    // Find profile + create Stripe customer if needed.
    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    const stripe = getStripe();
    let customerId = profile?.stripeCustomerId;
    if (!customerId) {
      // Pull email + name from Clerk so the Stripe customer record is
      // useful in the dashboard.
      let email: string | undefined;
      let name: string | undefined;
      try {
        const u = await currentUser();
        email = u?.emailAddresses?.[0]?.emailAddress ?? undefined;
        name = [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.username || undefined;
      } catch { /* okay */ }

      const customer = await stripe.customers.create({
        email,
        name,
        // The Clerk userId is our canonical key — store on the customer so
        // webhook lookups can resolve back to the right profile even if a
        // user's email changes.
        metadata: { sociafy_user_id: user.id },
      });
      customerId = customer.id;
      await db()
        .update(profiles)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(profiles.id, user.id));
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Pass the userId in case the customer record is somehow detached
      // — webhook prefers this metadata when present.
      subscription_data: {
        metadata: { sociafy_user_id: user.id, tier },
      },
      // Where Stripe sends the user when they finish (or abandon).
      success_url: absoluteUrl(req, `/billing?checkout=success&tier=${tier}`),
      cancel_url: absoluteUrl(req, '/billing?checkout=canceled'),
      // Helps Stripe detect if they're upgrading from another sub.
      allow_promotion_codes: true,
    });

    if (!session.url) {
      return jsonError('checkout_url_missing', 500);
    }
    return {
      url: session.url,
      sessionId: session.id,
      tier,
      tierLabel: TIER_META[tier].label,
    };
  }, req);
}
