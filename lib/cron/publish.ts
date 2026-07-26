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
    await db()
      .update(scheduledPosts)
      .set({ status: 'pending', updatedAt: now })
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
        await db().insert(activityLog).values({
          userId: sp.userId,
          kind: 'publish_failed',
          title: `Publish failed: ${sp.platform}`,
          body: msg,
          meta: { scheduledPostId: sp.id, platform: sp.platform, attempts: sp.attempts },
        });
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

    try {
      const out = await adapter.publishText({
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
        userId: sp.userId,
        kind: 'manual_publish',
        title: `Published to ${sp.platform}`,
        body: sp.text.slice(0, 280),
        meta: { scheduledPostId: sp.id, platform: sp.platform, url: out.url },
      });

      results.push({ id: sp.id, platform: sp.platform, ok: true, postId: out.platformPostId });
    } catch (e) {
      await fail(errMsg(e), isPermanent(e));
    }
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
