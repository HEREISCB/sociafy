import { NextRequest } from 'next/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withApiKey, apiKeyOfLedgerRow } from '../../../../lib/api-key';
import { db } from '../../../../lib/db';
import { apiKeys, creditLedger } from '../../../../lib/db/schema';
import { getBalance } from '../../../../lib/credits/ledger';
import { providerPreflight } from '../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/me — what a developer needs to debug their own integration:
 * is this key alive, what can it still spend, how much has it already spent.
 * One round trip, and it removes most "why did I get a 402/429" tickets.
 *
 * The spend window MUST mirror lib/api-key.ts's cap query exactly — rolling 24h,
 * attributed by the shared `apiKeyOfLedgerRow` expression, refunds netted out.
 * If this drifts, `daily_cap_remaining` starts lying about when the 429 hits.
 */
export async function GET(req: NextRequest) {
  return withApiKey(req, async (auth) => {
    const pre = providerPreflight({ r2: false });
    if (pre) return pre;

    const [[key], [spend], balance] = await Promise.all([
      db()
        .select({ prefix: apiKeys.prefix, cap: apiKeys.dailyCreditCap })
        .from(apiKeys)
        .where(eq(apiKeys.id, auth.apiKeyId))
        .limit(1),
      // The meter IS credit_ledger + meta.apiKeyId — there is no usage table.
      db()
        .select({ total: sql<number>`COALESCE(-SUM(${creditLedger.credits}), 0)::int` })
        .from(creditLedger)
        .where(
          and(
            inArray(creditLedger.kind, ['charge', 'refund']),
            sql`${apiKeyOfLedgerRow} = ${auth.apiKeyId}`,
            sql`${creditLedger.createdAt} > now() - interval '1 day'`,
          ),
        ),
      getBalance(auth.userId),
    ]);

    const charged = Number(spend?.total ?? 0);
    const cap = key?.cap ?? null;
    return Response.json({
      balance,
      key_prefix: key?.prefix ?? null,
      credits_charged_today: charged,
      daily_cap: cap,
      daily_cap_remaining: cap === null ? null : Math.max(0, cap - charged),
    });
  });
}
