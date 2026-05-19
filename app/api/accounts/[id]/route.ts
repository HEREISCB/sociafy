import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { connectedAccounts, activityLog } from '../../../../lib/db/schema';
import { decryptToken } from '../../../../lib/crypto/tokens';
import { revokeAtPlatform } from '../../../../lib/platforms/revoke';

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    // Read the row first so we can revoke at the platform — once the row is
    // gone we no longer have the tokens to send to the revoke endpoint.
    const [row] = await db()
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.userId, user.id)))
      .limit(1);
    if (!row) return jsonError('not_found', 404);

    // Best-effort: fire-and-forget revocation at the platform side. Don't
    // block the disconnect on the network call.
    if (!row.isStub) {
      const tokens = {
        accessToken: decryptToken(row.accessToken) ?? row.accessToken,
        refreshToken: row.refreshToken ? decryptToken(row.refreshToken) : null,
      };
      void revokeAtPlatform(row.platform, tokens);
    }

    await db()
      .delete(connectedAccounts)
      .where(eq(connectedAccounts.id, row.id));

    await db().insert(activityLog).values({
      userId: user.id,
      kind: 'platform_disconnected',
      title: `Disconnected ${row.platform}`,
      meta: { platform: row.platform, handle: row.handle },
    });
    return { ok: true };
  }, req);
}
