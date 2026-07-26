import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { grantIdempotent, getBalance } from '../../../../lib/credits/ledger';
import { rateLimit } from '../../../../lib/rate-limit';

export const runtime = 'nodejs';

// The three packs the demo page offers, and nothing else. A free-form
// 100..10_000 range let a caller mint a distinct source per amount and so
// bypass the once-per-pack cap below; an enum makes the cap a hard 12,500
// credits per user for all time.
const PACKS: readonly number[] = [500, 2_000, 10_000];

const bodySchema = z.object({
  credits: z.number().int().refine((n) => PACKS.includes(n), 'must be one of 500, 2000, 10000'),
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
 * ledger row is tagged with kind=admin_grant + meta.source='demo_grant:<pack>'
 * so it's distinguishable from real top-ups in the usage view.
 *
 * Capped: each pack can be granted once per user, ever. The cap is enforced by
 * the partial unique index on (user_id, kind, meta->>'source') via
 * grantIdempotent, so it holds across concurrent calls and needs no new column.
 * Previously this was auth'd but unlimited — a signed-in user could loop it for
 * unbounded free credits, and DEMO_CREDITS_ENABLED is one copy-paste from prod.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (process.env.DEMO_CREDITS_ENABLED !== '1') {
      return jsonError('demo_disabled', 403, {
        hint: 'Set DEMO_CREDITS_ENABLED=1 in the server env to enable the demo grant endpoint.',
      });
    }
    const rl = rateLimit('general', `demo-grant:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });

    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;
    const { credits } = parsed.data;

    const granted = await grantIdempotent({
      userId: user.id,
      kind: 'admin_grant',
      credits,
      source: `demo_grant:${credits}`,
      meta: { note: 'demo auto-purchase, no payment collected' },
    });
    if (!granted) {
      return jsonError('demo_pack_already_granted', 409, {
        hint: `You already claimed the ${credits.toLocaleString()} demo pack. Remaining packs: ${PACKS.filter((p) => p !== credits).join(', ')}.`,
      });
    }
    return { granted: credits, balance: await getBalance(user.id) };
  }, req);
}
