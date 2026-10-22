import { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { parseBody } from '../../../lib/validation';
import { db } from '../../../lib/db';
import { apiKeys, creditLedger } from '../../../lib/db/schema';
import { apiKeyOfLedgerRow, generateApiKey } from '../../../lib/api-key';

export const runtime = 'nodejs';

/** Row-spam ceiling. Rotation needs 2 live keys; 10 is generous. */
const MAX_KEYS_PER_USER = 10;

const createSchema = z.object({
  name: z.string().max(60).optional(),
  dailyCreditCap: z.number().int().min(1).max(100_000).optional(),
});

/** Public shape. keyHash is never selected, so it can't leak by accident. */
const publicCols = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  dailyCreditCap: apiKeys.dailyCreditCap,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
};

/** GET /api/keys — the caller's live API keys, newest first. Revoked keys are
 *  kept in the table (ledger rows reference them) but not listed. */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    // Rolling-24h spend per key, metered with the SAME expression the cap is
    // enforced with (lib/api-key.ts), refunds netted out, so the meter on
    // /account/api says exactly when the 429 lands.
    const spend = await db()
      .select({
        keyId: apiKeyOfLedgerRow,
        spent: sql<number>`COALESCE(-SUM(${creditLedger.credits}), 0)::int`,
      })
      .from(creditLedger)
      .where(and(
        eq(creditLedger.userId, user.id),
        inArray(creditLedger.kind, ['charge', 'refund']),
        sql`${creditLedger.createdAt} > now() - interval '1 day'`,
        sql`${apiKeyOfLedgerRow} IS NOT NULL`,
      ))
      .groupBy(apiKeyOfLedgerRow);
    const spentBy = new Map(spend.map((s) => [s.keyId, Math.max(0, Number(s.spent))]));

    const keys = await db()
      .select(publicCols)
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt));
    return keys.map((k) => ({ ...k, spent24h: spentBy.get(k.id) ?? 0 }));
  }, req);
}

/**
 * POST /api/keys — mint a key. The plaintext is returned exactly once here and
 * is unrecoverable afterwards (we only persist its SHA-256).
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(createSchema, raw);
    if (!parsed.ok) return parsed.response;

    const [{ count }] = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)));
    if (Number(count) >= MAX_KEYS_PER_USER) {
      return jsonError('too_many_keys', 400, {
        hint: `You already have ${MAX_KEYS_PER_USER} active API keys. Revoke one before creating another.`,
      });
    }

    const { full, prefix, keyHash } = generateApiKey();
    const [row] = await db()
      .insert(apiKeys)
      .values({
        userId: user.id,
        name: parsed.data.name ?? '',
        prefix,
        keyHash,
        ...(parsed.data.dailyCreditCap ? { dailyCreditCap: parsed.data.dailyCreditCap } : {}),
      })
      .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix });

    return { ...row, key: full };
  }, req);
}
