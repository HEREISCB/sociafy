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
import { PlatformError } from '../../../lib/platforms/types';
import { ensureFreshToken } from '../../../lib/platforms/token';
import { rateLimit } from '../../../lib/rate-limit';
import { publishSchema, parseBody } from '../../../lib/validation';

// POST /api/publish
// Body: { draftId, platforms?: Platform[] }
// Publishes immediately to each requested (or all targeted) platforms that the user
// has connected. Bypasses the cron — used by "Post Now" in compose.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('publish', user.id);
    if (!rl.ok) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) } },
      );
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(publishSchema, raw);
    if (!parsed.ok) return parsed.response;
    const { draftId, platforms } = parsed.data;

    const [draft] = await db()
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
      .limit(1);
    if (!draft) return jsonError('draft_not_found', 404);

    const requested: Platform[] = (platforms && platforms.length
      ? platforms
      : draft.targetPlatforms ?? []
    ).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
    console.log(`[publish] user=${user.id} draft=${draftId} platforms=${requested.join(',') || '<none>'}`);
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
      const initialAcct = byPlatform.get(platform);
      if (!initialAcct) {
        results.push({
          platform,
          ok: false,
          error: `platform_not_connected: no ${platform} account is connected (nothing was posted). Connect ${platform}, then try again.`,
        });
        continue;
      }
      const acct = await ensureFreshToken(initialAcct);

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

        // The adapter short-circuited to stubPublish: the platform isn't
        // configured or the account holds a stub token, so nothing was posted
        // and out.url is a dead stub.sociafy.local link. Same discipline as
        // lib/cron/publish.ts — a simulated publish is never a success.
        // Thrown so the existing failure path records it (row + activity log).
        if (out.stub) {
          throw new PlatformError(
            `platform_not_connected: ${platform} is not connected (publish was simulated — nothing was posted). Connect ${platform}, then try again.`,
            422,
          );
        }

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
        // Unwrap PlatformError so the upstream HTTP status + response body
        // make it back to the UI (and the activity log). Without this the
        // user just sees "x_publish_failed" with no clue what X actually
        // returned (rate limit? scope? duplicate?).
        const platformErr = e instanceof PlatformError ? e : null;
        const code = platformErr ? platformErr.message : (e instanceof Error ? e.message : String(e));
        const status = platformErr?.status;
        const detailRaw = platformErr?.detail;
        const detailText = typeof detailRaw === 'string'
          ? detailRaw
          : detailRaw != null
            ? (() => { try { return JSON.stringify(detailRaw); } catch { return String(detailRaw); } })()
            : '';
        const friendly = [code, status ? `(${status})` : '', detailText ? `· ${detailText.slice(0, 400)}` : '']
          .filter(Boolean).join(' ');
        console.error(`[publish] ${platform} failed: ${friendly}`);

        await db()
          .update(scheduledPosts)
          .set({ status: 'failed', error: friendly.slice(0, 2000), updatedAt: new Date() })
          .where(eq(scheduledPosts.id, sp.id));

        await db().insert(activityLog).values({
          userId: user.id,
          kind: 'publish_failed',
          title: `Publish failed: ${platform}`,
          body: friendly.slice(0, 1000),
          meta: { scheduledPostId: sp.id, platform, status: status ?? null },
        });

        results.push({ platform, ok: false, error: friendly, scheduledPostId: sp.id });
      }
    }

    const anyOk = results.some((r) => r.ok);
    if (anyOk) {
      await db()
        .update(drafts)
        .set({ status: 'published', updatedAt: new Date() })
        .where(eq(drafts.id, draft.id));
      return { results };
    }

    // Nothing was published. A 200 here reads as success to every caller
    // (apiPost only throws on non-2xx), which is how "post now" showed a green
    // result for a platform that was never connected. `error` carries the
    // per-platform reason verbatim so the client's message stays readable.
    const fixable = results.every((r) => r.error?.startsWith('platform_not_connected'));
    return jsonError(results[0]?.error ?? 'publish_failed', fixable ? 422 : 502, { results });
  }, req);
}
