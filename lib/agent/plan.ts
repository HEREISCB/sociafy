import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, drafts, scheduledPosts, activityLog, type DraftMedia, type DraftVariant, type Platform } from '../db/schema';
import { nextFreeSlot } from '../schedule/slots';
import { autoPlace, similarKey, DEFAULT_PER_DAY } from '../schedule/autoPlace';
import { postKind } from '../platforms/capabilities';
import { PLATFORM_LIMITS } from '../ai/compose';
import { getBalance } from '../credits/ledger';
import { draftCost } from '../credits/estimator';
import { weeklyTarget } from './status';
import { queueDraft, postText } from './publish';

type Draft = typeof drafts.$inferSelect;
type QuietHours = (typeof agentSettings.$inferSelect)['quietHours'];

const DAY_MS = 24 * 60 * 60 * 1000;
/** A planned time closer than this is treated as passed: re-slot rather than post the instant it's approved. */
const SOON_MS = 5 * 60_000;
/** Most posts one plan run (e.g. one "Generate") drafts — bounds its credit spend. */
export const PLAN_MAX = 30;

/** Drafts that belong in the review list: autopilot's, plus any draft the user gave a planned slot. */
const inReview = (userId: string) =>
  and(eq(drafts.userId, userId), eq(drafts.status, 'draft'), or(eq(drafts.source, 'agent'), isNotNull(drafts.plannedAt)));

/** Hard character limit per platform, as the composer and autopilot use it. */
export const CHAR_LIMITS = Object.fromEntries(Object.entries(PLATFORM_LIMITS).map(([p, l]) => [p, l.hard])) as Record<Platform, number>;

/** Platforms whose text for this draft is over their hard limit — the post would be rejected. */
export function tooLong(d: Pick<Draft, 'body' | 'perPlatformText' | 'variants' | 'targetPlatforms'>): Platform[] {
  return ((d.targetPlatforms ?? []) as Platform[]).filter((p) => postText(d, p).length > CHAR_LIMITS[p]);
}

/**
 * Approved while its video was still rendering. Kept on variant A (no column
 * for it): attachFinishedVideos sees it and schedules the post when the clip
 * lands instead of putting it back up for review.
 */
export const isApproved = (d: Pick<Draft, 'variants'>) => !!d.variants?.[0]?.approved;
const markApproved = (d: Draft): DraftVariant[] => {
  const [a, ...rest] = d.variants?.length ? d.variants : [{ label: 'A', text: d.body }];
  return [{ ...a, approved: true }, ...rest];
};

export type PlanView = Awaited<ReturnType<typeof getPlan>>;

/** The upcoming period at a glance — everything the review screen needs. */
export async function getPlan(userId: string, now = new Date(), days?: 7 | 30) {
  const [s] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  const horizonDays = days ?? s?.planHorizonDays ?? 7;
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
  // Same count as lib/agent/run.ts sizePlan: planned drafts plus recent
  // unplanned agent drafts (from before planning existed).
  const since = now.getTime() - horizonDays * DAY_MS;
  const planned = review.filter((d) => d.plannedAt || (d.source === 'agent' && new Date(d.createdAt).getTime() >= since)).length;
  const missing = Math.max(0, target - planned - scheduledDrafts);
  // What one Generate would cost (≈): capped posts × the content mix's average draft cost.
  const mix = s?.postsPerWeekByContentType ?? { text: 1, image: 0, video: 0 };
  const mixTotal = mix.text + mix.image + mix.video;
  const avgCost = mixTotal > 0
    ? (mix.text * draftCost('text') + mix.image * draftCost('image') + mix.video * draftCost('video')) / mixTotal
    : draftCost('text');
  const estimatedCredits = Math.ceil(Math.min(missing, PLAN_MAX) * avgCost);
  // Why a plan run would refuse right now (same checks as lib/agent/run.ts,
  // without its side effects). Accounts are the UI's to check: it has them.
  const blocked = !s ? 'no_settings'
    : !(s.niches ?? []).length ? 'no_niches'
    : missing > 0 && (await getBalance(userId)) < draftCost('text') * 2 ? 'insufficient_credits'
    : null;
  const taken = [...review.flatMap((d) => (d.plannedAt ? [new Date(d.plannedAt)] : [])), ...scheduled.map((p) => new Date(p.scheduledAt))];

  return {
    horizonDays,
    from: now.toISOString(),
    to: end.toISOString(),
    enabled: s?.enabled ?? false,
    mode: (s && s.autoPublishThreshold <= 100 ? 'auto' : 'review') as 'auto' | 'review',
    /** A plan run (cron top-up or Generate) is drafting right now — poll. */
    generating: !!s?.planRunningUntil && new Date(s.planRunningUntil) > now,
    limits: CHAR_LIMITS,
    review: review.map((d) => ({
      id: d.id,
      title: d.title,
      body: d.body,
      perPlatformText: d.perPlatformText ?? {},
      /** What each target platform would post right now (postText): the preview's tabs. */
      texts: Object.fromEntries(((d.targetPlatforms ?? []) as Platform[]).map((p) => [p, postText(d, p)])) as Partial<Record<Platform, string>>,
      targetPlatforms: d.targetPlatforms,
      media: (d.media ?? []) as DraftMedia[],
      plannedAt: d.plannedAt ? new Date(d.plannedAt).toISOString() : null,
      /** The planned time passed before approval; approve gives it the next free slot. */
      overdue: !!d.plannedAt && new Date(d.plannedAt) < now,
      /** Video still rendering. Approving it now schedules it when the clip lands. */
      rendering: !!d.videoJobId,
      /** Approved while rendering — waiting on the clip, not on the user. */
      approved: !!d.videoJobId && isApproved(d),
      /** Platforms whose text is over the limit; approve skips the draft with `too_long`. */
      tooLong: tooLong(d),
      score: d.variants?.[0]?.score ?? null,
      /** Autopilot's reason for this post ("Why this"), when it gave one. */
      rationale: d.variants?.[0]?.rationale ?? null,
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
      /** Drafts that still need the user (approved-while-rendering ones don't). */
      review: review.filter((d) => !(d.videoJobId && isApproved(d))).length,
      overdue: review.filter((d) => d.plannedAt && new Date(d.plannedAt) < now).length,
      rendering: review.filter((d) => d.videoJobId).length,
      /** Distinct posts (not per-platform rows) queued in the window. */
      scheduled: scheduledDrafts,
      /** Posts the horizon should hold: weekly target × weeks. */
      target,
      /** Still to be drafted to reach the target. */
      missing,
    },
    /** ≈ credits the next Generate would spend (at most PLAN_MAX posts). */
    estimatedCredits,
    /** no_settings | no_niches | insufficient_credits — the plan can't be filled until fixed. */
    blocked,
    nextEmptySlot: nextFreeSlot(now, s?.quietHours, taken).toISOString(),
  };
}

export type ApproveResult = {
  /** `rendering`: approved ahead of its clip — scheduled when it lands (scheduledAt is the planned slot, if any). */
  approved: { draftId: string; scheduledAt: string | null; platforms: Platform[]; reslotted: boolean; rendering?: true }[];
  skipped: { draftId: string; reason: string; reasons?: Record<string, string>; platforms?: Platform[] }[];
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

  for (let d of ordered) {
    const long = tooLong(d);
    if (long.length) { out.skipped.push({ draftId: d.id, reason: 'too_long', platforms: long }); continue; }
    if (d.videoJobId) {
      const when = wanted(d);
      // Conditional on the job we read: if the clip landed in between,
      // attachFinishedVideos already cleared it and saw no approval — 0 rows,
      // so queue it now like any other draft.
      const [marked] = await db()
        .update(drafts)
        .set({ variants: markApproved(d), plannedAt: when, updatedAt: new Date() })
        .where(and(eq(drafts.id, d.id), eq(drafts.userId, userId), eq(drafts.status, 'draft'), eq(drafts.videoJobId, d.videoJobId)))
        .returning({ id: drafts.id });
      if (marked) {
        out.approved.push({ draftId: d.id, scheduledAt: when?.toISOString() ?? null, platforms: d.targetPlatforms as Platform[], reslotted: false, rendering: true });
        continue;
      }
      const [fresh] = await db().select().from(drafts).where(and(eq(drafts.id, d.id), eq(drafts.userId, userId), eq(drafts.status, 'draft'))).limit(1);
      if (!fresh) { out.skipped.push({ draftId: d.id, reason: 'not_found' }); continue; }
      d = fresh;
    }
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

/**
 * The clip for a draft the user approved mid-render has landed: schedule it at
 * its planned slot, or the next free one if that has passed. Called from
 * attachFinishedVideos in place of the autopilot schedule-or-hold decision.
 */
export async function queueApprovedRender(draft: Draft, quiet: QuietHours | undefined, now = new Date()) {
  const pending = await db()
    .select({ at: scheduledPosts.scheduledAt })
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.userId, draft.userId), eq(scheduledPosts.status, 'pending'), gte(scheduledPosts.scheduledAt, now)));
  const planned = draft.plannedAt ? new Date(draft.plannedAt) : null;
  const at = planned && planned.getTime() >= now.getTime() + SOON_MS ? planned : nextFreeSlot(now, quiet, pending.map((p) => new Date(p.at)));
  const r = await queueDraft(draft, at);
  if (r.queued.length) {
    await db().insert(activityLog).values({
      userId: draft.userId,
      kind: 'draft_scheduled',
      title: `Approved for ${r.queued.join(', ')}`,
      meta: { draftId: draft.id, platforms: r.queued, scheduledAt: at.toISOString(), via: 'plan_render' },
    });
  }
  return r;
}

export type UnapproveResult = { restored: string[]; skipped: { draftId: string; reason: 'not_approved' | 'already_posting' }[] };

/**
 * Undo an approve: the draft goes back to review at `plannedAt` (its slot
 * before approve; null = no time). Its still-pending posts are deleted —
 * nothing went out, so nothing is left behind as "canceled" — and the
 * approved-while-rendering marker is cleared. A post already publishing or
 * published can't come back.
 */
export async function unapproveDrafts(userId: string, items: { draftId: string; plannedAt: string | null }[]): Promise<UnapproveResult> {
  const out: UnapproveResult = { restored: [], skipped: [] };
  for (const { draftId, plannedAt } of items) {
    const [d] = await db().select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.userId, userId))).limit(1);
    if (!d || !(d.status === 'scheduled' || (d.status === 'draft' && isApproved(d)))) { out.skipped.push({ draftId, reason: 'not_approved' }); continue; }
    const mine = and(eq(scheduledPosts.userId, userId), eq(scheduledPosts.draftId, draftId));
    // ponytail: check-then-delete; the cron claiming a row in between leaves that one platform posting. Undo lives for seconds, so fine.
    const live = await db().select({ id: scheduledPosts.id }).from(scheduledPosts).where(and(mine, inArray(scheduledPosts.status, ['publishing', 'published']))).limit(1);
    if (live.length) { out.skipped.push({ draftId, reason: 'already_posting' }); continue; }
    await db().delete(scheduledPosts).where(and(mine, eq(scheduledPosts.status, 'pending')));
    const variants = d.variants?.length ? d.variants.map((v, i) => (i === 0 ? { ...v, approved: false } : v)) : d.variants;
    const [row] = await db()
      .update(drafts)
      .set({ status: 'draft', plannedAt: plannedAt ? new Date(plannedAt) : null, variants, updatedAt: new Date() })
      .where(and(eq(drafts.id, draftId), eq(drafts.userId, userId), eq(drafts.status, d.status)))
      .returning({ id: drafts.id });
    if (row) out.restored.push(draftId);
    else out.skipped.push({ draftId, reason: 'not_approved' });
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

/**
 * "Spread across the week": every draft in review with no time (or one already
 * passed) gets a proposed slot over the plan horizon, in the user's time zone.
 * Only planned_at changes — it stays a draft to review; nothing is approved or
 * queued. Approved-while-rendering drafts keep theirs. Drafts that don't fit
 * (the horizon is full) stay unscheduled. Returns the old times for undo.
 * `only`: place just these drafts (e.g. ones just made), leaving the rest as they are.
 */
export async function spreadDrafts(userId: string, timeZone: string, now = new Date(), only?: string[]) {
  const [s] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  const [rows, planned, pending] = await Promise.all([
    db().select().from(drafts).where(and(inReview(userId), or(isNull(drafts.plannedAt), lt(drafts.plannedAt, now)))).orderBy(asc(drafts.createdAt)),
    db().select().from(drafts).where(and(inReview(userId), gte(drafts.plannedAt, now))),
    db()
      .select({ draftId: scheduledPosts.draftId, at: scheduledPosts.scheduledAt, media: scheduledPosts.media })
      .from(scheduledPosts)
      .where(and(eq(scheduledPosts.userId, userId), inArray(scheduledPosts.status, ['pending', 'publishing']), gte(scheduledPosts.scheduledAt, now))),
  ]);
  const kind = (d: Draft) => (d.videoJobId ? 'video' : postKind(d.media));
  const loose = rows.filter((d) => !isApproved(d) && (!only || only.includes(d.id)));
  const posts = new Map(pending.map((p) => [p.draftId, p])); // one per post, not per platform row
  const placed = autoPlace({
    items: loose.map((d) => ({ id: d.id, kind: kind(d), group: similarKey(d.title) })),
    taken: [
      ...planned.map((d) => ({ at: new Date(d.plannedAt!), kind: kind(d), group: similarKey(d.title) })),
      ...[...posts.values()].map((p) => ({ at: new Date(p.at), kind: postKind(p.media) })),
    ],
    from: now,
    days: s?.planHorizonDays ?? 7,
    timeZone,
    perDay: Math.max(DEFAULT_PER_DAY, s ? Math.ceil(weeklyTarget(s) / 7) : 0),
    quiet: s?.quietHours,
  });
  const out: { draftId: string; plannedAt: string; previous: string | null }[] = [];
  for (const d of loose) {
    const at = placed.get(d.id);
    if (!at) continue;
    // Conditional on the time we read: a drag or approve in between wins.
    const [row] = await db()
      .update(drafts)
      .set({ plannedAt: at, updatedAt: new Date() })
      .where(and(eq(drafts.id, d.id), eq(drafts.userId, userId), eq(drafts.status, 'draft'), d.plannedAt ? eq(drafts.plannedAt, d.plannedAt) : isNull(drafts.plannedAt)))
      .returning({ id: drafts.id });
    if (row) out.push({ draftId: d.id, plannedAt: at.toISOString(), previous: d.plannedAt ? new Date(d.plannedAt).toISOString() : null });
  }
  return { placed: out, left: loose.length - out.length };
}
