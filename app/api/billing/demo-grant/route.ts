import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { grant } from '../../../../lib/credits/ledger';

export const runtime = 'nodejs';

const bodySchema = z.object({
  credits: z.number().int().min(100).max(10_000),
});

/**
 * POST /api/billing/demo-grant — non-payment credit grant for demos.
 *
 * Why: real Razorpay/Stripe checkout isn't usable in every demo environment
 * (no test cards in some regions, sandbox webhooks need a public URL, etc.).
 * This endpoint lets a signed-in user grant themselves a chunk of credits
 * directly so the rest of the product can be exercised end-to-end.
 *
 * Gated by DEMO_CREDITS_ENABLED=1 — leave unset in real production. The
 * ledger row is tagged with kind=admin_grant + meta.source='demo_grant'
 * so it's distinguishable from real top-ups in the usage view.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (process.env.DEMO_CREDITS_ENABLED !== '1') {
      return jsonError('demo_disabled', 403, {
        hint: 'Set DEMO_CREDITS_ENABLED=1 in the server env to enable the demo grant endpoint.',
      });
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;

    const result = await grant({
      userId: user.id,
      kind: 'admin_grant',
      credits: parsed.data.credits,
      meta: { source: 'demo_grant', note: 'demo auto-purchase, no payment collected' },
    });
    return { granted: parsed.data.credits, balance: result.balanceAfter };
  }, req);
}
