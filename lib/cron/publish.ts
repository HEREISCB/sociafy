import { and, eq, lte, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  scheduledPosts,
  connectedAccounts,
  activityLog,
  drafts,
} from '../db/schema';
import { getAdapter } from '../platforms/registry';
import { ensureFreshToken } from '../platforms/token';

export type PublishResult = {
  id: string;
  platform: string;
  ok: boolean;
  error?: string;
  postId?: string;
};

/**
 * Publish all scheduled_posts whose scheduledAt has passed.
 *
 * Concurrency: claims posts atomically with a single UPDATE ... RETURNING so
 * two overlapping invocations cannot both pick up the same row. This is the
 * fix for the TOCTOU race the prior SELECT-then-UPDATE pattern had.
 */
export async function runPublish(): Promise<{ ran: number; results: PublishResult[] }> {
  const now = new Date();

  // Atomic claim. Posts that are still 'pending' and overdue get flipped to
  // 'publishing' and returned in one round-trip. Two concurrent crons cannot
  // each grab the same row — Postgres serializes the UPDATE.
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
    const initialAcct = accountById.get(sp.accountId);
    if (!initialAcct) {
      await markFailed(sp.id, 'no_account');
      results.push({ id: sp.id, platform: sp.platform, ok: false, error: 'no_account' });
      continue;
    }

    let acct;
    try {
      acct = await ensureFreshToken(initialAcct);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await markFailed(sp.id, `token_refresh_failed: ${msg}`);
      results.push({ id: sp.id, platform: sp.platform, ok: false, error: 'token_refresh_failed' });
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
      const msg = e instanceof Error ? e.message : String(e);
      await markFailed(sp.id, msg);
      await db().insert(activityLog).values({
        userId: sp.userId,
        kind: 'publish_failed',
        title: `Publish failed: ${sp.platform}`,
        body: msg,
        meta: { scheduledPostId: sp.id, platform: sp.platform },
      });
      results.push({ id: sp.id, platform: sp.platform, ok: false, error: msg });
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

async function markFailed(id: string, error: string) {
  await db()
    .update(scheduledPosts)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(eq(scheduledPosts.id, id));
}
