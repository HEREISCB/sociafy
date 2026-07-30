import { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { apiKeys } from '../../../../lib/db/schema';

export const runtime = 'nodejs';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same bounds as POST /api/keys. The cap is the developer's own blast radius
 *  on a money-spending key, so it must be adjustable without rotating the key —
 *  the 429's hint and docs/api.md both promise it is. */
const patchSchema = z.object({ dailyCreditCap: z.number().int().min(1).max(100_000) });

/** PATCH /api/keys/[id] — change the rolling-24h credit cap. Tenant-scoped and
 *  live-only: a revoked key's cap is meaningless. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    if (!UUID_RX.test(id)) return jsonError('not_found', 404);
    const parsed = parseBody(patchSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const [row] = await db()
      .update(apiKeys)
      .set({ dailyCreditCap: parsed.data.dailyCreditCap })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id, dailyCreditCap: apiKeys.dailyCreditCap });
    if (!row) return jsonError('not_found', 404);
    return row;
  }, req);
}

/** DELETE /api/keys/[id] — revoke. Soft: the row stays so ledger entries
 *  tagged with this apiKeyId remain explainable. Tenant-scoped, 404 on miss. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    // A non-uuid id would make Postgres error out as a 500; it's just a miss.
    if (!UUID_RX.test(id)) return jsonError('not_found', 404);
    const [row] = await db()
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
      .returning({ id: apiKeys.id });
    if (!row) return jsonError('not_found', 404);
    return { ok: true };
  }, req);
}
