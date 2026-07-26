import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../../../../lib/db';
import { shieldActions, mentions, activityLog, connectedAccounts } from '../../../../../../lib/db/schema';
import { authedUser } from '../../../../../../lib/api';
import { getAdapter } from '../../../../../../lib/platforms/registry';
import { ensureFreshToken } from '../../../../../../lib/platforms/token';
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
  // 'failed' is retryable: re-approving re-attempts the publish (the catch
  // below is the only writer of that status, and nothing else resets it — so
  // without this a transient 502 stranded the drafted reply forever).
  if (action.status !== 'pending' && action.status !== 'failed') {
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
      error: null, // clear a previous attempt's error on retry
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
      const msg = `No connected account for ${targetPlatform}`;
      await failAction(id, msg);
      return NextResponse.json(
        { error: 'no_account', platform: targetPlatform, hint: `Connect ${targetPlatform} first — nothing was posted.` },
        { status: 422 },
      );
    }

    // Refresh before publishing, like the publish cron does — a short-lived
    // token (X: 2h) would otherwise hard-fail with a 401.
    const fresh = await ensureFreshToken(acct);
    // ensureFreshToken returns the STALE token when the provider refresh
    // failed (it stamps lastRefreshError instead of throwing). If that token
    // is also past expiry, publishing can only 401 — say "reconnect" instead.
    const expired = fresh.tokenExpiresAt !== null && new Date(fresh.tokenExpiresAt).getTime() <= Date.now();
    if (fresh.lastRefreshError && expired) {
      const msg = `reconnect_needed: ${targetPlatform} token expired and could not be refreshed (${fresh.lastRefreshError.slice(0, 200)}). Nothing was posted.`;
      await failAction(id, msg);
      return NextResponse.json(
        { error: 'reconnect_needed', platform: targetPlatform, hint: `Reconnect ${targetPlatform} on the Connections page, then approve again — nothing was posted.` },
        { status: 422 },
      );
    }

    try {
      const adapter = getAdapter(targetPlatform);

      const result = await adapter.publishText({
        text: scriptToUse,
        account: {
          id: fresh.id,
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken,
          platformUserId: fresh.platformUserId,
          meta: targetPostId ? { parentId: targetPostId } : fresh.meta,
        },
      });

      // stubPublish short-circuit: the platform isn't configured or the
      // account holds a stub token, so no reply exists anywhere. Recording
      // 'published' here told users a crisis had been answered when it hadn't.
      if (result.stub) {
        const msg = `platform_not_connected: ${targetPlatform} is not connected (the reply was simulated — nothing was posted). Connect ${targetPlatform}, then approve again.`;
        await failAction(id, msg);
        return NextResponse.json(
          { error: 'platform_not_connected', platform: targetPlatform, hint: msg },
          { status: 422 },
        );
      }

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
      await failAction(id, errMsg);
      return NextResponse.json(
        {
          error: 'publish_failed',
          detail: errMsg,
          // The UI renders `hint` verbatim; without it a 502 shows only a
          // generic "server error" and the real platform reason is lost.
          hint: `Publishing to ${targetPlatform} failed: ${errMsg.slice(0, 300)}. The draft was kept — you can approve again to retry.`,
        },
        { status: 502 },
      );
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

/** Park the action as 'failed' with the reason. 'failed' is retryable — the
 *  guard above lets a re-approve run this handler again. */
async function failAction(id: string, error: string) {
  await db()
    .update(shieldActions)
    .set({ status: 'failed', error: error.slice(0, 2000), updatedAt: new Date() })
    .where(eq(shieldActions.id, id));
}
