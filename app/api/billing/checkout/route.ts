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
 * requested tier. Returns a CheckoutHandoff the client opens: Razorpay modal
 * params, always charged in INR regardless of the customer's location.
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
      // Only reachable when Razorpay has no credentials. Error code kept for
      // the billing page's copy.
      return jsonError('billing_coming_soon', 503, {
        hint: 'Payments are not configured yet. Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.',
      });
    }

    try {
      return await provider.startSubscription({ userId: user.id, tier: parsed.data.tier });
    } catch (e) {
      // Provider SDKs reject with a plain object, not an Error — `String(e)`
      // on one of those is the literal "[object Object]", which is how this
      // used to reach the logs AND the client. Log the real code/description
      // so a failure here is diagnosable (e.g. Razorpay's
      // "Invoices disabled because fee bearer is customer"), and hand the
      // client a sentence instead of provider internals.
      console.error(
        `[billing/checkout] ${provider.name} startSubscription failed for user=${user.id} tier=${parsed.data.tier}:`,
        describeError(e),
      );
      return jsonError('checkout_unavailable', 502, {
        hint: "We couldn't start checkout — our payment provider rejected the request. Nothing was charged. Please try again in a few minutes, or contact support if it keeps happening.",
      });
    }
  }, req);
}

/**
 * Readable one-liner for anything a provider SDK might reject with. Razorpay
 * throws `{ statusCode, error: { code, description, reason, ... } }`; Stripe
 * throws an Error subclass carrying `code`/`type`. Server-side logging only —
 * never send this to a client.
 */
function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (e && typeof e === 'object') {
    const o = e as { statusCode?: number; error?: { code?: string; description?: string; reason?: string; source?: string; step?: string } };
    if (o.error?.description || o.error?.code) {
      return [
        o.statusCode ? `status=${o.statusCode}` : null,
        o.error.code ? `code=${o.error.code}` : null,
        o.error.reason ? `reason=${o.error.reason}` : null,
        o.error.description ? `description=${o.error.description}` : null,
      ].filter(Boolean).join(' ');
    }
    try { return JSON.stringify(e); } catch { /* circular */ }
  }
  return String(e);
}
