import { and, asc, eq, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, drafts, scheduledPosts, activityLog, type DraftMedia, type Platform } from '../db/schema';
import { nextFreeSlot } from '../schedule/slots';
import { weeklyTarget } from './status';
import { queueDraft } from './publish';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A planned time closer than this is treated as passed: re-slot rather than post the instant it's approved. */
const SOON_MS = 5 * 60_000;

/** Drafts that belong in the review list: autopilot's, plus any draft the user gave a planned slot. */
const inReview = (userId: string) =>
  and(eq(drafts.userId, userId), eq(drafts.status, 'draft'), or(eq(drafts.source, 'agent'), isNotNull(drafts.plannedAt)));

export type PlanView = Awaited<ReturnType<typeof getPlan>>;

/** The upcoming period at a glance — everything the review screen needs. */
export async function getPlan(userId: string, now = new Date()) {
  const [s] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  const horizonDays = s?.planHorizonDays ?? 7;
  const end = new Date(now.getTime() + horizonDays * DAY_MS);
  const [review, scheduled] = await Promise.all([
    db()
      .select()
      .from(drafts)
      .where(inReview(userId))
      .orderBy(sql`${drafts.plannedAt} asc nulls last`, asc(drafts.createdAt))
      .limit(200),
    db()
      .select()
      .from(scheduledPosts)
      .where(and(eq(scheduledPosts.userId, userId), inArray(scheduledPosts.status, ['pending', 'publishing']), gte(scheduledPosts.scheduledAt, now), lt(scheduledPosts.scheduledAt, end)))
      .orderBy(asc(scheduledPosts.scheduledAt))
      .limit(500),
  ]);

  const target = s ? Math.ceil(weeklyTarget(s) * horizonDays / 7) : 0;
  const scheduledDrafts = new Set(scheduled.map((p) => p.draftId)).size;
  const planned = review.filter((d) => d.plannedAt).length;
  const taken = [...review.flatMap((d) => (d.plannedAt ? [new Date(d.plannedAt)] : [])), ...scheduled.map((p) => new Date(p.scheduledAt))];

  return {
    horizonDays,
    from: now.toISOString(),
    to: end.toISOString(),
    enabled: s?.enabled ?? false,
    mode: (s && s.autoPublishThreshold <= 100 ? 'auto' : 'review') as 'auto' | 'review',
    /** A plan run (cron top-up or Generate) is drafting right now — poll. */
    generating: !!s?.planRunningUntil && new Date(s.planRunningUntil) > now,
    review: review.map((d) => ({
      id: d.id,
      title: d.title,
      body: d.body,
      perPlatformText: d.perPlatformText ?? {},
      targetPlatforms: d.targetPlatforms,
      media: (d.media ?? []) as DraftMedia[],
      plannedAt: d.plannedAt ? new Date(d.plannedAt).toISOString() : null,
      /** The planned time passed before approval; approve gives it the next free slot. */
      overdue: !!d.plannedAt && new Date(d.plannedAt) < now,
      /** Video still rendering — can't be approved until the clip lands. */
      rendering: !!d.videoJobId,
      score: d.variants?.[0]?.score ?? null,
      source: d.source,
      createdAt: new Date(d.createdAt).toISOString(),
    })),
    scheduled: scheduled.map((p) => ({
      id: p.id,
      draftId: p.draftId,
      platform: p.platform,
      scheduledAt: new Date(p.scheduledAt).toISOString(),
      status: p.status,
      text: p.text,
      media: (p.media ?? []) as DraftMedia[],
    })),
    counts: {
      review: review.length,
      overdue: review.filter((d) => d.plannedAt && new Date(d.plannedAt) < now).length,
      rendering: review.filter((d) => d.videoJobId).length,
      /** Distinct posts (not per-platform rows) queued in the window. */
      scheduled: scheduledDrafts,
      /** Posts the horizon should hold: weekly target × weeks. */
      target,
      /** Still to be drafted to reach the target. */
      missing: Math.max(0, target - planned - scheduledDrafts),
    },
    nextEmptySlot: nextFreeSlot(now, s?.quietHours, taken).toISOString(),
  };
}

export type ApproveResult = {
  approved: { draftId: string; scheduledAt: string; platforms: Platform[]; reslotted: boolean }[];
  skipped: { draftId: string; reason: string; reasons?: Record<string, string> }[];
};

/**
 * Approve drafts: each becomes scheduled posts at its planned slot (or the
 * override). A slot already passed — or missing — moves to the next free one.
 * Same platform checks and text rules as POST /api/schedule.
 */
export async function approveDrafts(
  userId: string,
  req: { draftIds?: string[]; all?: boolean; overrides?: Record<string, string> },
  now = new Date(),
): Promise<ApproveResult> {
  const [s] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  const rows = await db()
    .select()
    .from(drafts)
    .where(req.all ? inReview(userId) : and(eq(drafts.userId, userId), eq(drafts.status, 'draft'), inArray(drafts.id, req.draftIds ?? [])));
  const pending = await db()
    .select({ at: scheduledPosts.scheduledAt })
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.userId, userId), eq(scheduledPosts.status, 'pending'), gte(scheduledPosts.scheduledAt, now)));
  // Other drafts' planned slots stay reserved while we re-slot the overdue ones.
  const approving = new Set(rows.map((r) => r.id));
  const reserved = await db()
    .select({ id: drafts.id, at: drafts.plannedAt })
    .from(drafts)
    .where(and(inReview(userId), isNotNull(drafts.plannedAt), gte(drafts.plannedAt, now)));
  const taken = [...pending.map((p) => new Date(p.at)), ...reserved.filter((r) => !approving.has(r.id)).map((r) => new Date(r.at!))];

  const out: ApproveResult = { approved: [], skipped: [] };
  const found = new Set(rows.map((r) => r.id));
  for (const id of req.draftIds ?? []) if (!found.has(id)) out.skipped.push({ draftId: id, reason: 'not_found' });

  const wanted = (d: (typeof rows)[number]) => {
    const o = req.overrides?.[d.id];
    return o ? new Date(o) : d.plannedAt ? new Date(d.plannedAt) : null;
  };
  // Chronological, so overdue posts re-slot into the earliest gaps first and
  // undated ones go last.
  const ordered = rows.sort((a, b) => (wanted(a)?.getTime() ?? Infinity) - (wanted(b)?.getTime() ?? Infinity));

  for (const d of ordered) {
    if (d.videoJobId) { out.skipped.push({ draftId: d.id, reason: 'rendering' }); continue; }
    let at = wanted(d);
    const reslotted = !at || at.getTime() < now.getTime() + SOON_MS;
    if (reslotted) at = nextFreeSlot(now, s?.quietHours, taken);
    const r = await queueDraft(d, at!);
    if (r.queued.length === 0) {
      out.skipped.push({ draftId: d.id, reason: r.reasons.draft ?? 'no_platforms', reasons: r.reasons });
      continue;
    }
    taken.push(at!);
    out.approved.push({ draftId: d.id, scheduledAt: at!.toISOString(), platforms: r.queued, reslotted });
    await db().insert(activityLog).values({
      userId,
      kind: 'draft_scheduled',
      title: `Approved for ${r.queued.join(', ')}`,
      meta: { draftId: d.id, platforms: r.queued, scheduledAt: at!.toISOString(), via: 'plan' },
    });
  }
  return out;
}

/** Discard a draft from the plan. Its slot frees up for the next top-up. */
export async function skipDraft(userId: string, draftId: string): Promise<boolean> {
  const [row] = await db()
    .update(drafts)
    .set({ status: 'archived', plannedAt: null, updatedAt: new Date() })
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, userId), eq(drafts.status, 'draft')))
    .returning({ id: drafts.id });
  return !!row;
}
