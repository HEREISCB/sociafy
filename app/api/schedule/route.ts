import { NextRequest } from 'next/server';
import { and, eq, desc, gte, lte } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { db } from '../../../lib/db';
import {
  scheduledPosts,
  drafts,
  connectedAccounts,
  activityLog,
  PLATFORMS,
  type Platform,
  type DraftMedia,
} from '../../../lib/db/schema';
import { scheduleCreateSchema, parseBody } from '../../../lib/validation';

export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const sp = req.nextUrl.searchParams;
    const from = sp.get('from');
    const to = sp.get('to');
    const conditions = [eq(scheduledPosts.userId, user.id)];
    if (from) conditions.push(gte(scheduledPosts.scheduledAt, new Date(from)));
    if (to) conditions.push(lte(scheduledPosts.scheduledAt, new Date(to)));
    const rows = await db()
      .select()
      .from(scheduledPosts)
      .where(and(...conditions))
      .orderBy(desc(scheduledPosts.scheduledAt))
      .limit(500);
    return rows;
  });
}

// Body: { draftId, scheduledAt (ISO), platforms?: Platform[] }
// If platforms omitted, schedules to draft.targetPlatforms.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(scheduleCreateSchema, raw);
    if (!parsed.ok) return parsed.response;
    const { draftId, scheduledAt: scheduledAtRaw, platforms } = parsed.data;
    const scheduledAt = new Date(scheduledAtRaw);
    // Reject past schedules — cron picks them up immediately, which is almost
    // never what the user meant (and confusing if a typo created the date).
    if (scheduledAt.getTime() < Date.now() - 60_000) {
      return jsonError('scheduledAt_in_past');
    }

    const [draft] = await db()
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.userId, user.id)))
      .limit(1);
    if (!draft) return jsonError('draft_not_found', 404);

    const requestedPlatforms: Platform[] = (platforms && platforms.length
      ? platforms
      : draft.targetPlatforms ?? []
    ).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
    if (requestedPlatforms.length === 0) return jsonError('no_platforms');

    const accounts = await db()
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, user.id));
    const accountByPlatform = new Map(accounts.map((a) => [a.platform, a]));

    const inserted = [];
    for (const platform of requestedPlatforms) {
      const acct = accountByPlatform.get(platform);
      if (!acct) continue; // skip platforms with no connected account
      const text = (draft.perPlatformText as Record<string, string> | null)?.[platform] ?? draft.body;
      const [row] = await db()
        .insert(scheduledPosts)
        .values({
          userId: user.id,
          draftId: draft.id,
          accountId: acct.id,
          platform,
          scheduledAt,
          text,
          media: (draft.media ?? []) as DraftMedia[],
        })
        .returning();
      inserted.push(row);
    }

    if (inserted.length > 0) {
      await db().update(drafts).set({ status: 'scheduled', updatedAt: new Date() }).where(eq(drafts.id, draft.id));
      await db().insert(activityLog).values({
        userId: user.id,
        kind: 'draft_scheduled',
        title: `Scheduled to ${inserted.map((r) => r.platform).join(', ')}`,
        meta: { draftId: draft.id, platforms: inserted.map((r) => r.platform), scheduledAt: scheduledAt.toISOString() },
      });
    }

    return { scheduled: inserted };
  }, req);
}
