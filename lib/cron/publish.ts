import { and, eq, lte, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  scheduledPosts,
  connectedAccounts,
  activityLog,
  drafts,
} from '../db/schema';
import { getAdapter } from '../platforms/registry';
import { PlatformError } from '../platforms/types';
import { ensureFreshToken } from '../platforms/token';

export type PublishResult = {
  id: string;
  platform: string;
  ok: boolean;
  error?: string;
  postId?: string;
  /** Requeued as 'pending' — a later tick will try again. */
  willRetry?: boolean;
};

/** Total tries per post, counted by scheduled_posts.attempts. The cron runs
 *  every 5 min (vercel.json), so that's the backoff — no sleep, no queue. */
const MAX_ATTEMPTS = 3;

/**
 * Publish all scheduled_posts whose scheduledAt has passed.
 *
 * Concurrency: claims posts atomically with a single UPDATE ... RETURNING so
 * two overlapping invocations cannot both pick up the same row. This is the
 * fix for the TOCTOU race the prior SELECT-then-UPDATE pattern had.
 *
 * Retries: a transient failure requeues the row as 'pending' with the error
 * recorded, so the next tick reclaims it (and increments attempts again).
 * Terminal 'failed' only once attempts hit MAX_ATTEMPTS or the failure is
 * clearly permanent (see isPermanent).
 */
export async function runPublish(): Promise<{ ran: number; results: PublishResult[] }> {
  const now = new Date();

  // Atomic claim. Posts that are still 'pending' and overdue get flipped to
  // 'publishing' and returned in one round-trip. Two concurrent crons cannot
  // each grab the same row — Postgres serializes the UPDATE.
  //
  // ponytail: a row stranded in 'publishing' by a killed invocation is never
  // reclaimed. Reclaiming on a staleness window would risk double-posting a
  // row that succeeded just before the crash; add it only with a platform
  // idempotency key.
  const due = await db()
    .update(scheduledPosts)
    .set({
      status: 'publishing',
      attempts: sql`${scheduledPosts.attempts} + 1`,
      updatedAt: now,
    })
    .where(and(eq(scheduledPosts.status, 'pending'), lte(scheduledPosts.scheduledAt, now)))
    .returning();

  if (due.length === 0) return { ran: 0, results: [] };

  // Cap per-run batch size after the claim so we don't run forever. Re-queue
  // the overflow back to 'pending' so the next tick picks them up.
  const BATCH_LIMIT = 50;
  let batch = due;
  if (due.length > BATCH_LIMIT) {
    batch = due.slice(0, BATCH_LIMIT);
    const overflow = due.slice(BATCH_LIMIT).map((p) => p.id);
    // Give the attempt back: the claim already incremented it, but these rows
    // never reached a platform. Without this they burn MAX_ATTEMPTS on ticks
    // that never tried to publish them.
    await db()
      .update(scheduledPosts)
      .set({ status: 'pending', attempts: sql`${scheduledPosts.attempts} - 1`, updatedAt: now })
      .where(inArray(scheduledPosts.id, overflow));
  }

  const accountIds = Array.from(new Set(batch.map((d) => d.accountId)));
  const accounts = await db()
    .select()
    .from(connectedAccounts)
    .where(inArray(connectedAccounts.id, accountIds));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const results: PublishResult[] = [];

  for (const sp of batch) {
    // Every failure path goes through here so the retry/terminal decision
    // lives in exactly one place.
    const fail = async (msg: string, permanent: boolean) => {
      const willRetry = !permanent && sp.attempts < MAX_ATTEMPTS;
      if (willRetry) {
        // Back to 'pending' so the next tick reclaims it. attempts is already
        // incremented by the claim, so it can't loop forever.
        await db()
          .update(scheduledPosts)
          .set({ status: 'pending', error: `retrying (${sp.attempts}/${MAX_ATTEMPTS}): ${msg}`, updatedAt: new Date() })
          .where(eq(scheduledPosts.id, sp.id));
      } else {
        await markFailed(sp.id, msg);
        // Only log the terminal verdict — logging every retry spams the feed.
        // Never let a log write take down the rest of the batch.
        try {
          await db().insert(activityLog).values({
            userId: sp.userId,
            kind: 'publish_failed',
            title: `Publish failed: ${sp.platform}`,
            body: msg,
            meta: { scheduledPostId: sp.id, platform: sp.platform, attempts: sp.attempts },
          });
        } catch (e) {
          console.error(`[cron.publish] activity log failed for failed post ${sp.id}: ${errMsg(e)}`);
        }
      }
      results.push({ id: sp.id, platform: sp.platform, ok: false, error: msg, willRetry });
    };

    const initialAcct = accountById.get(sp.accountId);
    if (!initialAcct) {
      await fail('no_account', true);
      continue;
    }

    let acct;
    try {
      acct = await ensureFreshToken(initialAcct);
    } catch (e) {
      // ensureFreshToken swallows provider refresh failures (it stamps the row
      // and returns the stale token), so a throw here is our own infra —
      // transient by default.
      await fail(`token_refresh_failed: ${errMsg(e)}`, isPermanent(e));
      continue;
    }

    const adapter = getAdapter(sp.platform);

    // ── The only retryable window. Everything after this try has either not
    // touched the platform yet, or has already put a post on the customer's
    // real account — and a live post must NEVER go back to 'pending'.
    let out;
    try {
      out = await adapter.publishText({
        text: sp.text,
        media: (sp.media ?? []) as { url: string; mimeType: string }[],
        account: {
          id: acct.id,
          accessToken: acct.accessToken,
          refreshToken: acct.refreshToken,
          platformUserId: acct.platformUserId,
          meta: acct.meta as Record<string, unknown> | null,
        },
      });
    } catch (e) {
      // A PlatformError carries an HTTP status: the platform answered and
      // said no, so nothing was posted and retrying is safe. Anything else
      // (socket hangup, timeout, `TypeError: fetch failed`) means we never
      // got a verdict — the post may well be live. No adapter sends an
      // idempotency key, so a retry is a coin-flip on double-posting to a
      // real account. Go terminal and let the user decide.
      // ponytail: send a per-row idempotency key where the platform supports
      // one (X, LinkedIn), then these can retry safely.
      const unconfirmed = !(e instanceof PlatformError);
      await fail(
        unconfirmed ? `publish_unconfirmed: ${errMsg(e)} — the post may or may not be live. Check ${sp.platform} before rescheduling.` : errMsg(e),
        unconfirmed || isPermanent(e),
      );
      continue;
    }

    // The adapter short-circuited to stubPublish: the platform isn't
    // configured or the account holds a stub token, so nothing was posted
    // and out.url is a dead stub.sociafy.local link. Recording this as
    // 'published' is how users ended up with green posts they could never
    // find. Terminal — retrying can't connect an account.
    if (out.stub) {
      await fail(
        `platform_not_connected: ${sp.platform} is not connected (publish was simulated — nothing was posted). Connect ${sp.platform}, then reschedule.`,
        true,
      );
      continue;
    }

    // ── Past this line the post IS LIVE. Bookkeeping only: every failure is
    // swallowed and logged loudly. A row stuck in 'publishing' (never
    // reclaimed) or a missing activity-log line is strictly better than
    // posting to the customer's account a second time.
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
        `[cron.publish] PUBLISHED BUT NOT RECORDED — scheduled_post=${sp.id} platform=${sp.platform} platformPostId=${out.platformPostId} url=${out.url ?? ''}: ${errMsg(e)}`,
      );
    }

    try {
      await db().insert(activityLog).values({
        userId: sp.userId,
        kind: 'manual_publish',
        title: `Published to ${sp.platform}`,
        body: sp.text.slice(0, 280),
        meta: { scheduledPostId: sp.id, platform: sp.platform, url: out.url },
      });
    } catch (e) {
      console.error(`[cron.publish] activity log failed for published post ${sp.id}: ${errMsg(e)}`);
    }

    results.push({ id: sp.id, platform: sp.platform, ok: true, postId: out.platformPostId });
  }

  // Mark draft 'published' if all of its scheduled posts are published.
  // Defense-in-depth: filter by userId so we never touch a draft that isn't
  // ours, even though the FK already ties draftId → drafts.id.
  const draftKeys = new Map<string, string>(); // draftId → userId
  for (const sp of batch) {
    if (sp.draftId) draftKeys.set(sp.draftId, sp.userId);
  }
  for (const [did, uid] of draftKeys) {
    const remaining = await db()
      .select({ status: scheduledPosts.status })
      .from(scheduledPosts)
      .where(eq(scheduledPosts.draftId, did));
    if (remaining.length > 0 && remaining.every((r) => r.status === 'published')) {
      await db()
        .update(drafts)
        .set({ status: 'published', updatedAt: new Date() })
        .where(and(eq(drafts.id, did), eq(drafts.userId, uid)));
    }
  }

  return { ran: results.length, results };
}

function errMsg(e: unknown): string {
  // PlatformError.message is a bare code ('x_publish_failed'); the useful part
  // is detail (the upstream body). Keep both, bounded — this string is shown
  // to the user on the calendar and in the activity feed.
  if (e instanceof PlatformError && e.detail) {
    const detail = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
    return `${e.message}: ${detail}`.slice(0, 900);
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Is retrying pointless? Adapters throw PlatformError carrying the upstream
 * HTTP status: 4xx means the request itself is wrong (revoked token 401/403,
 * missing media 400, exhausted X credits 402) and will be just as wrong in
 * 5 minutes. 408/429 and every 5xx are transient, as is anything that isn't
 * a PlatformError (fetch/DNS/socket errors).
 */
export function isPermanent(e: unknown): boolean {
  if (!(e instanceof PlatformError)) return false;
  return e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

async function markFailed(id: string, error: string) {
  await db()
    .update(scheduledPosts)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(eq(scheduledPosts.id, id));
}
