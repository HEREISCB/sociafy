import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { connectedAccounts, activityLog } from '../../../../lib/db/schema';

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const [row] = await db()
      .delete(connectedAccounts)
      .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.userId, user.id)))
      .returning();
    if (!row) return jsonError('not_found', 404);
    await db().insert(activityLog).values({
      userId: user.id,
      kind: 'platform_disconnected',
      title: `Disconnected ${row.platform}`,
      meta: { platform: row.platform, handle: row.handle },
    });
    return { ok: true };
  });
}
