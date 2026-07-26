import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { apiKeys } from '../../../../lib/db/schema';

export const runtime = 'nodejs';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
