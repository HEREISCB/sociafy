import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { profiles, TIER_CREDITS, type Tier } from '../../../lib/db/schema';
import { getBalance, recentLedger } from '../../../lib/credits/ledger';
import { ACTION_LABELS, type CreditAction } from '../../../lib/credits/pricing';

export const runtime = 'nodejs';

/**
 * GET /api/credits — returns current balance, tier metadata, and the
 * recent ledger (last 50 rows) for the usage page.
 *
 * Shape:
 *   {
 *     balance: number,
 *     tier: 'starter' | 'pro' | 'business',
 *     monthlyAllocation: number,
 *     creditCycleStart: ISO string,
 *     ledger: Array<{ id, kind, action, label, credits, meta, createdAt }>
 *   }
 */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const [profile] = await db()
      .select({
        tier: profiles.tier,
        creditCycleStart: profiles.creditCycleStart,
      })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    const tier = (profile?.tier ?? 'starter') as Tier;
    const balance = await getBalance(user.id);
    const ledger = await recentLedger(user.id, 50);

    return {
      balance,
      tier,
      monthlyAllocation: TIER_CREDITS[tier],
      creditCycleStart: profile?.creditCycleStart?.toISOString() ?? null,
      ledger: ledger.map((row) => ({
        id: row.id,
        kind: row.kind,
        action: row.action,
        label: row.action
          ? ACTION_LABELS[row.action as CreditAction] ?? row.action
          : labelForKind(row.kind),
        credits: row.credits,
        meta: row.meta,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }, req);
}

function labelForKind(kind: string): string {
  switch (kind) {
    case 'signup_bonus': return 'Welcome bonus';
    case 'monthly_grant': return 'Monthly allocation';
    case 'topup': return 'Top-up purchase';
    case 'admin_grant': return 'Manual grant';
    case 'refund': return 'Refund';
    default: return kind;
  }
}
