import { NextRequest, NextResponse } from 'next/server';
import { and, eq, lte, inArray } from 'drizzle-orm';
import { checkCronAuth } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import {
  scheduledPosts,
  connectedAccounts,
  activityLog,
  drafts,
} from '../../../../lib/db/schema';
import { getAdapter } from '../../../../lib/platforms/registry';
import { isStubMode } from '../../../../lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (isStubMode.database()) {
    return NextResponse.json({ skipped: 'no_database' });
  }

  const now = new Date();
  const due = await db()
    .select()
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.status, 'pending'), lte(scheduledPosts.scheduledAt, now)))
    .limit(50);

  if (due.length === 0) return NextResponse.json({ ran: 0 });

  // Fetch accounts in one shot
  const accountIds = Array.from(new Set(due.map((d) => d.accountId)));
  const accounts = await db()
    .select()
    .from(connectedAccounts)
    .where(inArray(connectedAccounts.id, accountIds));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const results: Array<{ id: string; platform: string; ok: boolean; error?: string; postId?: string }> = [];

  for (const sp of due) {
    // Mark publishing to prevent double-pickup
    await db()
      .update(scheduledPosts)
      .set({ status: 'publishing', attempts: (sp.attempts ?? 0) + 1, updatedAt: new Date() })
      .where(eq(scheduledPosts.id, sp.id));

    const acct = accountById.get(sp.accountId);
    if (!acct) {
      await markFailed(sp.id, 'no_account');
      results.push({ id: sp.id, platform: sp.platform, ok: false, error: 'no_account' });
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

  // Mark draft 'published' if all of its scheduled posts are published
  const draftIds = Array.from(new Set(due.map((d) => d.draftId)));
  for (const did of draftIds) {
    const remaining = await db()
      .select({ id: scheduledPosts.id, status: scheduledPosts.status })
      .from(scheduledPosts)
      .where(eq(scheduledPosts.draftId, did));
    if (remaining.length > 0 && remaining.every((r) => r.status === 'published')) {
      await db().update(drafts).set({ status: 'published', updatedAt: new Date() }).where(eq(drafts.id, did));
    }
  }

  return NextResponse.json({ ran: results.length, results });
}

async function markFailed(id: string, error: string) {
  await db()
    .update(scheduledPosts)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(eq(scheduledPosts.id, id));
}
