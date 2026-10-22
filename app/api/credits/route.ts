import { NextRequest } from 'next/server';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { creditLedger, profiles, TIER_CREDITS, type Tier } from '../../../lib/db/schema';
import { getBalance } from '../../../lib/credits/ledger';
import { ACTION_LABELS, type CreditAction } from '../../../lib/credits/pricing';
import { summarizeCycle } from '../../../lib/ui/ledgerLabel';

export const runtime = 'nodejs';

const PAGE = 50;

/**
 * GET /api/credits — current balance, tier metadata, and one page of the
 * ledger (newest 50) for the usage page. Read-only.
 *
 *   ?before=<ISO createdAt>  the page older than that row ("Load older")
 *   ?cycle=1                 adds `cycle`: carriedOver/added/spent/refunded and
 *                            spend per category since creditCycleStart
 *
 * Shape:
 *   {
 *     balance, tier, monthlyAllocation, creditCycleStart,
 *     ledger: Array<{ id, kind, action, label, credits, meta, createdAt }>,
 *     hasMore: boolean,
 *     cycle?: CycleSummary
 *   }
 */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const params = req.nextUrl.searchParams;
    const beforeRaw = params.get('before');
    const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;

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
    const rows = await db()
      .select()
      .from(creditLedger)
      .where(before
        ? and(eq(creditLedger.userId, user.id), lt(creditLedger.createdAt, before))
        : eq(creditLedger.userId, user.id))
      .orderBy(desc(creditLedger.createdAt))
      .limit(PAGE + 1);
    const ledger = rows.slice(0, PAGE);

    let cycle;
    if (params.get('cycle') && profile?.creditCycleStart) {
      const sums = await db()
        .select({
          kind: creditLedger.kind,
          action: creditLedger.action,
          credits: sql<number>`SUM(${creditLedger.credits})::int`,
        })
        .from(creditLedger)
        .where(and(eq(creditLedger.userId, user.id), gte(creditLedger.createdAt, profile.creditCycleStart)))
        .groupBy(creditLedger.kind, creditLedger.action);
      cycle = summarizeCycle(sums.map((s) => ({ ...s, credits: Number(s.credits) })), balance);
    }

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
      hasMore: rows.length > PAGE,
      ...(cycle ? { cycle } : {}),
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
