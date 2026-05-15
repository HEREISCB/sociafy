import { NextRequest } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { db } from '../../../lib/db';
import {
  drafts,
  connectedAccounts,
  scheduledPosts,
  activityLog,
  PLATFORMS,
  type Platform,
} from '../../../lib/db/schema';
import { getAdapter } from '../../../lib/platforms/registry';

// POST /api/publish
// Body: { draftId, platforms?: Platform[] }
// Publishes immediately to each requested (or all targeted) platforms that the user
// has connected. Bypasses the cron — used by "Post Now" in compose.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const body = await req.json().catch(() => ({}));
    const draftId = body?.draftId as string | undefined;
    if (!draftId) return jsonError('draftId_required');

    const [draft] = await db()
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
      .limit(1);
    if (!draft) return jsonError('draft_not_found', 404);

    const requested: Platform[] = (Array.isArray(body?.platforms) && body.platforms.length
      ? body.platforms
      : draft.targetPlatforms ?? []
    ).filter((p: string): p is Platform => (PLATFORMS as readonly string[]).includes(p));
    if (requested.length === 0) return jsonError('no_platforms');

    const accounts = await db()
      .select()
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.userId, user.id),
        inArray(connectedAccounts.platform, requested),
      ));
    const byPlatform = new Map(accounts.map((a) => [a.platform, a]));

    const now = new Date();
    const results: Array<{
      platform: Platform;
      ok: boolean;
      url?: string | null;
      platformPostId?: string;
      error?: string;
      scheduledPostId?: string;
    }> = [];

    for (const platform of requested) {
      const acct = byPlatform.get(platform);
      if (!acct) {
        results.push({ platform, ok: false, error: 'account_not_connected' });
        continue;
      }

      const text = (draft.perPlatformText as Record<string, string> | null)?.[platform] ?? draft.body;
      const media = (draft.media ?? []) as { id: string; url: string; mimeType: string }[];

      // Create a scheduled_post row with status=publishing for audit trail
      const [sp] = await db()
        .insert(scheduledPosts)
        .values({
          userId: user.id,
          draftId: draft.id,
          accountId: acct.id,
          platform,
          scheduledAt: now,
          status: 'publishing',
          text,
          media,
          attempts: 1,
        })
        .returning();

      try {
        const adapter = getAdapter(platform);
        const out = await adapter.publishText({
          text,
          media: media.map((m) => ({ url: m.url, mimeType: m.mimeType })),
          account: {
            id: acct.id,
            accessToken: acct.accessToken,
            refreshToken: acct.refreshToken,
            platformUserId: acct.platformUserId,
            meta: acct.meta as Record<string, unknown> | null,
          },
        });

        await db()
          .update(scheduledPosts)
          .set({
            status: 'published',
            publishedAt: new Date(),
            platformPostId: out.platformPostId,
            platformPostUrl: out.url ?? null,
            updatedAt: new Date(),
          })
          .where(eq(scheduledPosts.id, sp.id));

        await db().insert(activityLog).values({
          userId: user.id,
          kind: 'manual_publish',
          title: `Published to ${platform}`,
          body: text.slice(0, 280),
          meta: { scheduledPostId: sp.id, platform, url: out.url, immediate: true },
        });

        results.push({
          platform,
          ok: true,
          url: out.url ?? null,
          platformPostId: out.platformPostId,
          scheduledPostId: sp.id,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await db()
          .update(scheduledPosts)
          .set({ status: 'failed', error: msg, updatedAt: new Date() })
          .where(eq(scheduledPosts.id, sp.id));

        await db().insert(activityLog).values({
          userId: user.id,
          kind: 'publish_failed',
          title: `Publish failed: ${platform}`,
          body: msg,
          meta: { scheduledPostId: sp.id, platform },
        });

        results.push({ platform, ok: false, error: msg, scheduledPostId: sp.id });
      }
    }

    const anyOk = results.some((r) => r.ok);
    if (anyOk) {
      await db()
        .update(drafts)
        .set({ status: 'published', updatedAt: new Date() })
        .where(eq(drafts.id, draft.id));
    }

    return { results };
  });
}
