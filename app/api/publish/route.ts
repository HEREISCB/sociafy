import { NextRequest } from 'next/server';
import { and, eq, gte, inArray, or } from 'drizzle-orm';
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
import { PlatformError, publishWarning } from '../../../lib/platforms/types';
import { ensureFreshToken } from '../../../lib/platforms/token';
import { rateLimit } from '../../../lib/rate-limit';
import { publishSchema, parseBody } from '../../../lib/validation';
import { postText } from '../../../lib/agent/publish';

/** A draft published to a platform this recently is treated as a duplicate
 *  click, not a deliberate repost. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

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

    const connected: Platform[] = [];
    for (const platform of requested) {
      if (byPlatform.has(platform)) {
        connected.push(platform);
        continue;
      }
      results.push({
        platform,
        ok: false,
        error: `platform_not_connected: no ${platform} account is connected (nothing was posted). Connect ${platform}, then try again.`,
      });
    }

    const media = (draft.media ?? []) as { id: string; url: string; mimeType: string }[];

    // Claim before publishing. A double-click (or the cron) racing this
    // request used to post the same draft twice. Locking the draft row
    // serializes concurrent claims; the loser sees the winner's 'publishing'
    // (or just-'published') rows and skips those platforms. Each claimed
    // platform gets its scheduled_post row (status=publishing) for the audit
    // trail.
    const claimed = connected.length === 0 ? [] : await db().transaction(async (tx) => {
      await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, draft.id)).for('update');
      const busy = await tx
        .select({ platform: scheduledPosts.platform })
        .from(scheduledPosts)
        .where(and(
          eq(scheduledPosts.draftId, draft.id),
          inArray(scheduledPosts.platform, connected),
          or(
            eq(scheduledPosts.status, 'publishing'),
            and(eq(scheduledPosts.status, 'published'), gte(scheduledPosts.publishedAt, new Date(now.getTime() - DUPLICATE_WINDOW_MS))),
          ),
        ));
      const busySet = new Set(busy.map((b) => b.platform));
      const rows: (typeof scheduledPosts.$inferSelect)[] = [];
      for (const platform of connected) {
        if (busySet.has(platform)) {
          results.push({
            platform,
            ok: false,
            error: `already_publishing: this draft is already being (or was just) posted to ${platform}. Nothing new was posted.`,
          });
          continue;
        }
        const [sp] = await tx
          .insert(scheduledPosts)
          .values({
            userId: user.id,
            draftId: draft.id,
            accountId: byPlatform.get(platform)!.id,
            platform,
            scheduledAt: now,
            status: 'publishing',
            text: postText(draft, platform),
            media,
            attempts: 1,
          })
          .returning();
        rows.push(sp);
        // A still-pending scheduled row for this draft+platform would post it
        // a second time when the cron reaches it.
        await tx
          .update(scheduledPosts)
          .set({ status: 'canceled', error: 'superseded_by_post_now', updatedAt: now })
          .where(and(
            eq(scheduledPosts.draftId, draft.id),
            eq(scheduledPosts.platform, platform),
            eq(scheduledPosts.status, 'pending'),
          ));
      }
      return rows;
    });

    for (const sp of claimed) {
      const platform = sp.platform;
      const text = sp.text;

      // Nothing reached the platform, or the platform answered "no". Only
      // ever called from before/at the publish call — never after a live post.
      // notPosted: the failure happened before the platform call.
      const fail = async (e: unknown, notPosted = false) => {
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
        // No HTTP status means the platform never gave us a verdict (socket
        // hangup, timeout, `TypeError: fetch failed`) — the post may well be
        // live. No adapter sends an idempotency key, so telling the user to
        // click "Post now" again is a coin-flip on double-posting to a real
        // account. Say so instead of inviting the retry.
        // ponytail: send a per-post idempotency key where the platform
        // supports one (X, LinkedIn), then this can safely retry.
        const friendly = platformErr || notPosted
          ? [code, status ? `(${status})` : '', detailText ? `· ${detailText.slice(0, 400)}` : '']
              .filter(Boolean).join(' ')
          : `publish_unconfirmed: ${code} — the post may or may not be live. Check ${platform} before trying again.`;
        console.error(`[publish] ${platform} failed: ${friendly}`);
        results.push({ platform, ok: false, error: friendly, scheduledPostId: sp.id });

        // Bookkeeping: a DB blip here must not 500 the request after another
        // platform already went live (the user would click "Post now" again).
        try {
          await db()
            .update(scheduledPosts)
            .set({ status: 'failed', error: friendly.slice(0, 2000), updatedAt: new Date() })
            .where(eq(scheduledPosts.id, sp.id));

          // Definitely not live → give back the scheduled post we superseded.
          // If the outcome is unknown, leave it canceled rather than risk a
          // double post.
          if (notPosted || status) {
            await db()
              .update(scheduledPosts)
              .set({ status: 'pending', error: null, updatedAt: new Date() })
              .where(and(
                eq(scheduledPosts.draftId, sp.draftId),
                eq(scheduledPosts.platform, platform),
                eq(scheduledPosts.status, 'canceled'),
                eq(scheduledPosts.error, 'superseded_by_post_now'),
              ));
          }

          await db().insert(activityLog).values({
            userId: user.id,
            kind: 'publish_failed',
            title: `Publish failed: ${platform}`,
            body: friendly.slice(0, 1000),
            meta: { scheduledPostId: sp.id, platform, status: status ?? null },
          });
        } catch (dbErr) {
          console.error(`[publish] failure not recorded for ${sp.id}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
        }
      };

      let acct;
      try {
        acct = await ensureFreshToken(byPlatform.get(platform)!);
      } catch (e) {
        await fail(new Error(`token_refresh_failed: ${e instanceof Error ? e.message : String(e)}`), true);
        continue;
      }

      // ── The only window where a failure is safe to report. Everything past
      // this try has either not touched the platform yet, or has already put
      // a post on the customer's real account — and a live post must NEVER be
      // reported as failed, because the user's fix is to click "Post now"
      // again. Same discipline as lib/cron/publish.ts.
      const adapter = getAdapter(platform);
      let out;
      try {
        out = await adapter.publishText({
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
      } catch (e) {
        await fail(e);
        continue;
      }

      // The adapter short-circuited to stubPublish: the platform isn't
      // configured or the account holds a stub token, so nothing was posted
      // and out.url is a dead stub.sociafy.local link. Same discipline as
      // lib/cron/publish.ts — a simulated publish is never a success.
      if (out.stub) {
        await fail(new PlatformError(
          `platform_not_connected: ${platform} is not connected (publish was simulated — nothing was posted). Connect ${platform}, then try again.`,
          422,
        ));
        continue;
      }

      // ── Past this line the post IS LIVE. Bookkeeping only: every failure is
      // swallowed and logged loudly. A row stranded in 'publishing' or a
      // missing activity-log line is strictly better than telling the user
      // their post failed and having them post it to their feed twice.
      try {
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
      } catch (e) {
        console.error(
          `[publish] PUBLISHED BUT NOT RECORDED — scheduled_post=${sp.id} platform=${platform} platformPostId=${out.platformPostId} url=${out.url ?? ''}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      try {
        await db().insert(activityLog).values({
          userId: user.id,
          kind: 'manual_publish',
          title: `Published to ${platform}`,
          body: text.slice(0, 280),
          meta: { scheduledPostId: sp.id, platform, url: out.url, immediate: true },
        });
      } catch (e) {
        console.error(`[publish] activity log failed for published post ${sp.id}: ${e instanceof Error ? e.message : String(e)}`);
      }

      const warning = publishWarning(platform, out);
      if (warning) {
        try {
          await db().insert(activityLog).values({
            userId: user.id,
            kind: 'publish_warning',
            title: warning,
            body: text.slice(0, 280),
            meta: { scheduledPostId: sp.id, platform, url: out.url, immediate: true },
          });
        } catch (e) {
          console.error(`[publish] activity log failed for publish warning ${sp.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      results.push({
        platform,
        ok: true,
        url: out.url ?? null,
        platformPostId: out.platformPostId,
        scheduledPostId: sp.id,
      });
    }

    const anyOk = results.some((r) => r.ok);
    if (anyOk) {
      // Also bookkeeping after a live post — a throw here would 500 the
      // request and send the user straight back to "Post now".
      try {
        await db()
          .update(drafts)
          .set({ status: 'published', updatedAt: new Date() })
          .where(eq(drafts.id, draft.id));
      } catch (e) {
        console.error(`[publish] draft ${draft.id} not marked published: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { results };
    }

    // Nothing was published. A 200 here reads as success to every caller
    // (apiPost only throws on non-2xx), which is how "post now" showed a green
    // result for a platform that was never connected. `error` carries the
    // per-platform reason verbatim so the client's message stays readable.
    const fixable = results.every((r) => r.error?.startsWith('platform_not_connected'));
    const duplicate = results.every((r) => r.error?.startsWith('already_publishing'));
    return jsonError(results[0]?.error ?? 'publish_failed', fixable ? 422 : duplicate ? 409 : 502, { results });
  }, req);
}
