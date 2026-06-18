import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../../../../lib/db';
import { shieldActions, mentions, activityLog, connectedAccounts } from '../../../../../../lib/db/schema';
import { authedUser } from '../../../../../../lib/api';
import { getAdapter } from '../../../../../../lib/platforms/registry';
import { decryptToken } from '../../../../../../lib/crypto/tokens';
import type { Platform } from '../../../../../../lib/db/schema';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({})) as {
    script?: string;
    targetPlatform?: string;
    targetPostId?: string;
  };

  // Load the action
  const [action] = await db()
    .select()
    .from(shieldActions)
    .where(and(eq(shieldActions.id, id), eq(shieldActions.userId, user.id)))
    .limit(1);

  if (!action) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (action.status !== 'pending') {
    return NextResponse.json({ error: 'already_processed', status: action.status }, { status: 409 });
  }

  const scriptToUse = body.script ?? action.script;
  const targetPlatform = (body.targetPlatform ?? action.targetPlatform) as Platform | null;
  const targetPostId = body.targetPostId ?? action.targetPostId ?? null;

  // Mark approved
  await db()
    .update(shieldActions)
    .set({
      status: 'approved',
      script: scriptToUse,
      targetPlatform,
      targetPostId,
      approvedBy: user.id,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(shieldActions.id, id));

  // Publish if a target platform is specified
  let publishedPostId: string | null = null;
  let publishUrl: string | null = null;

  if (targetPlatform) {
    const [acct] = await db()
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.userId, user.id),
          eq(connectedAccounts.platform, targetPlatform),
        ),
      )
      .limit(1);

    if (!acct) {
      await db()
        .update(shieldActions)
        .set({ status: 'failed', error: `No connected account for ${targetPlatform}`, updatedAt: new Date() })
        .where(eq(shieldActions.id, id));
      return NextResponse.json({ error: 'no_account', platform: targetPlatform }, { status: 422 });
    }

    try {
      const adapter = getAdapter(targetPlatform);
      const decrypted = decryptToken(acct.accessToken);
      if (!decrypted) throw new Error('token_decrypt_failed');

      const result = await adapter.publishText({
        text: scriptToUse,
        account: {
          id: acct.id,
          accessToken: decrypted,
          refreshToken: decryptToken(acct.refreshToken),
          platformUserId: acct.platformUserId,
          meta: targetPostId ? { parentId: targetPostId } : acct.meta,
        },
      });

      publishedPostId = result.platformPostId;
      publishUrl = result.url ?? null;

      await db()
        .update(shieldActions)
        .set({
          status: 'published',
          publishedPostId,
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(shieldActions.id, id));

      await db().insert(activityLog).values({
        userId: user.id,
        kind: 'shield_response_published',
        title: `Shield response published to ${targetPlatform}`,
        body: scriptToUse.slice(0, 200),
        meta: { platform: targetPlatform, publishedPostId, shieldActionId: id },
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await db()
        .update(shieldActions)
        .set({ status: 'failed', error: errMsg, updatedAt: new Date() })
        .where(eq(shieldActions.id, id));
      return NextResponse.json({ error: 'publish_failed', detail: errMsg }, { status: 502 });
    }
  } else {
    // No platform selected — just mark approved (user will publish manually)
    await db().insert(activityLog).values({
      userId: user.id,
      kind: 'shield_response_approved',
      title: 'Shield response approved (no platform selected)',
      body: scriptToUse.slice(0, 200),
      meta: { shieldActionId: id },
    });
  }

  return NextResponse.json({
    ok: true,
    status: targetPlatform ? 'published' : 'approved',
    publishedPostId,
    publishUrl,
  });
}
