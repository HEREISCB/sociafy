import { and, eq, gte, lt, asc, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, drafts, scheduledPosts, creditLedger, connectedAccounts, trends, type Niche, type Platform, type PostsPerWeekByType } from '../db/schema';
import { getBalance } from '../credits/ledger';
import { draftCost } from '../credits/estimator';
import { postKind, supportsKind, type PostKind } from '../platforms/capabilities';

const DAY_MS = 24 * 60 * 60 * 1000;
// ponytail: mirrors the agent cron ("0 */2 * * *" in etc/cron.d/sociafy and
// scheduled-jobs.yml). Change the cron, change this — it only drives the
// "next top-up" time shown to the user, never whether a draft is allowed.
const TICK_HOURS = 2;

/**
 * Posts per week autopilot aims for. The content mix IS the plan — 4 text +
 * 2 image + 1 video means 7 a week. cadencePerWeek only speaks for rows saved
 * before the mix existed (or with an all-zero mix).
 */
export function weeklyTarget(s: { cadencePerWeek: number; postsPerWeekByContentType?: PostsPerWeekByType | null }): number {
  const m = s.postsPerWeekByContentType;
  return (m ? m.text + m.image + m.video : 0) || s.cadencePerWeek;
}

/** The first cron tick at or after `d` — when a plan with gaps actually gets topped up. */
export function nextTick(d: Date): Date {
  const t = new Date(d);
  if (t.getUTCMinutes() || t.getUTCSeconds() || t.getUTCMilliseconds()) t.setUTCHours(t.getUTCHours() + 1);
  t.setUTCMinutes(0, 0, 0);
  if (t.getUTCHours() % TICK_HOURS) t.setUTCHours(t.getUTCHours() + 1);
  return t;
}

/** What autopilot has done in the trailing `days` (default 7) — the inputs to every pacing decision. */
export async function loadWeek(userId: string, now = new Date(), days = 7) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const recent = await db()
    .select({ createdAt: drafts.createdAt, media: drafts.media, videoJobId: drafts.videoJobId })
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.source, 'agent'), gte(drafts.createdAt, since)));
  // Every autopilot charge — copy, image, video — is tagged meta.via. (Not
  // meta.source: that key is uniquely indexed per user for idempotency.)
  const charges = await db()
    .select({ id: creditLedger.id, credits: creditLedger.credits })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), gte(creditLedger.createdAt, since), sql`${creditLedger.meta}->>'via' = 'autopilot'`));
  // A failed render is refunded as a new row pointing back at its charge.
  const refunds = charges.length === 0 ? [] : await db()
    .select({ credits: creditLedger.credits })
    .from(creditLedger)
    .where(inArray(creditLedger.relatedLedgerId, charges.map((c) => c.id)));
  const done: Record<PostKind, number> = { text: 0, image: 0, video: 0 };
  for (const r of recent) done[r.videoJobId ? 'video' : postKind(r.media)]++;
  return {
    draftTimes: recent.map((r) => new Date(r.createdAt)),
    done,
    creditsThisWeek: Math.max(0, -[...charges, ...refunds].reduce((sum, r) => sum + r.credits, 0)),
  };
}

/**
 * Which kind of post to draft next, best first. The kind furthest behind its
 * weekly share leads; a kind no enabled platform can publish is dropped (an
 * Instagram-only account never gets a text post). Text always closes the list
 * where some platform takes it, so a plan with budget left still produces.
 */
export function kindQueue(mix: PostsPerWeekByType, done: Record<PostKind, number>, platforms: Platform[]): PostKind[] {
  const kinds: PostKind[] = ['text', 'image', 'video'];
  const behind = (k: PostKind) => (mix[k] > 0 ? (mix[k] - done[k]) / mix[k] : 0);
  const usable = kinds.filter((k) => platforms.some((p) => supportsKind(p, k)));
  // Stable sort: ties keep text < image < video, i.e. cheapest first.
  const wanted = usable.filter((k) => behind(k) > 0).sort((a, b) => behind(b) - behind(a));
  if (usable.includes('text') && !wanted.includes('text')) wanted.push('text');
  // Mix met (or never set) on an account text can't reach, e.g. Instagram-only:
  // an image rather than "nowhere to post". Never a video nobody asked for —
  // that is 149 credits.
  return wanted.length ? wanted : usable.filter((k) => k !== 'video').slice(0, 1);
}

/** The first kind in the queue the balance and weekly cap can pay for — or what stopped it. */
export function affordableKind(queue: PostKind[], balance: number, cap: number | null | undefined, creditsThisWeek: number):
  { kind: PostKind } | { blocked: 'no_credits' | 'credit_cap' | 'no_platforms' } {
  if (queue.length === 0) return { blocked: 'no_platforms' };
  const inBalance = queue.filter((k) => draftCost(k) <= balance);
  if (inBalance.length === 0) return { blocked: 'no_credits' };
  const kind = inBalance.find((k) => typeof cap !== 'number' || creditsThisWeek + draftCost(k) <= cap);
  return kind ? { kind } : { blocked: 'credit_cap' };
}

export type AgentBlock = 'no_niches' | 'no_platforms' | 'no_credits' | 'credit_cap' | 'no_trends';

export type AgentStatus = {
  enabled: boolean;
  /** Why the plan can't be topped up. Null = nothing in the way. */
  blocked: AgentBlock | null;
  /** 'auto' = drafts scoring ≥ threshold post on their own. 'review' = nothing posts without approval. */
  mode: 'auto' | 'review';
  threshold: number;
  /** How far ahead autopilot keeps the plan filled (7 or 30). */
  horizonDays: number;
  /** Posts already in the window: planned drafts + posts queued to go out. */
  planned: number;
  /** Posts the window should hold: weekly target × weeks. */
  target: number;
  /** Posts that actually land inside the window: drafts planned in it + posts queued in it. `planned` also
   *  counts overdue drafts (they get a new slot on approve), so it can read "33 of 5"; this can't. */
  ready: number;
  /** Credits autopilot spent in the trailing horizon, net of refunds — what the weekly cap is checked against. */
  creditsThisWeek: number;
  /** ISO time of the cron tick that adds the missing posts. Null when paused, blocked or the plan is full. */
  nextTopUpAt: string | null;
  /** The plan has gaps and nothing blocks it — switching on starts filling it now. */
  dueNow: boolean;
  balance: number;
  /** Agent drafts still waiting for the user. */
  pendingReview: { id: string; title: string | null; createdAt: Date; rendering: boolean }[];
  /** Earliest post already queued to go out. */
  nextPostAt: string | null;
};

/** Posts the horizon should hold, and when the cron next tops it up (null = full, paused or blocked). */
export function planGap(weeklyPosts: number, horizonDays: number, planned: number, now: Date, live: boolean) {
  const target = Math.ceil(weeklyPosts * horizonDays / 7);
  const gap = planned < target;
  return { target, gap, nextTopUpAt: live && gap ? nextTick(now).toISOString() : null };
}

export async function getAgentStatus(userId: string, now = new Date()): Promise<AgentStatus | null> {
  const [s] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  if (!s) return null;
  const horizonDays = s.planHorizonDays ?? 7;
  const end = new Date(now.getTime() + horizonDays * DAY_MS);
  const [period, balance, connected, [freshTrend], pendingReview, [nextPost], [plannedDrafts], [queuedDrafts]] = await Promise.all([
    loadWeek(userId, now, horizonDays),
    getBalance(userId),
    db().select({ platform: connectedAccounts.platform }).from(connectedAccounts).where(eq(connectedAccounts.userId, userId)),
    db().select({ id: trends.id }).from(trends).where(and(eq(trends.userId, userId), eq(trends.status, 'new'))).limit(1),
    db()
      .select({ id: drafts.id, title: drafts.title, createdAt: drafts.createdAt, videoJobId: drafts.videoJobId })
      .from(drafts)
      .where(and(eq(drafts.userId, userId), eq(drafts.source, 'agent'), eq(drafts.status, 'draft')))
      .orderBy(asc(drafts.createdAt))
      .limit(20),
    db()
      .select({ at: scheduledPosts.scheduledAt })
      .from(scheduledPosts)
      .where(and(eq(scheduledPosts.userId, userId), eq(scheduledPosts.status, 'pending'), gte(scheduledPosts.scheduledAt, now)))
      .orderBy(asc(scheduledPosts.scheduledAt))
      .limit(1),
    // Same counting as run.ts sizePlan: every unreviewed planned draft, plus
    // distinct drafts queued inside the window.
    db()
      .select({
        n: sql<number>`count(*)::int`,
        inWindow: sql<number>`(count(*) filter (where ${drafts.plannedAt} >= ${now.toISOString()}::timestamptz and ${drafts.plannedAt} < ${end.toISOString()}::timestamptz))::int`,
      })
      .from(drafts)
      .where(and(eq(drafts.userId, userId), eq(drafts.status, 'draft'), isNotNull(drafts.plannedAt))),
    db()
      .select({ n: sql<number>`count(distinct ${scheduledPosts.draftId})::int` })
      .from(scheduledPosts)
      .where(and(eq(scheduledPosts.userId, userId), eq(scheduledPosts.status, 'pending'), gte(scheduledPosts.scheduledAt, now), lt(scheduledPosts.scheduledAt, end))),
  ]);

  // Same rule as run.ts: a platform counts only if it is switched on AND connected.
  const platforms = ((s.enabledPlatforms ?? []) as Platform[]).filter((p) => connected.some((c) => c.platform === p));
  // Mirrors run.ts sizePlan: the mix and the cap are per week, the plan spans the horizon.
  const weeks = horizonDays / 7;
  const m = s.postsPerWeekByContentType;
  const mix = { text: m.text * weeks, image: m.image * weeks, video: m.video * weeks };
  const cap = typeof s.weeklyCreditCap === 'number' ? s.weeklyCreditCap * weeks : null;
  const next = affordableKind(kindQueue(mix, period.done, platforms), balance, cap, period.creditsThisWeek);
  const planned = (plannedDrafts?.n ?? 0) + (queuedDrafts?.n ?? 0);
  const gap = planGap(weeklyTarget(s), horizonDays, planned, now, true).gap;
  const blocked: AgentBlock | null =
    ((s.niches ?? []) as Niche[]).length === 0 ? 'no_niches'
    : platforms.length === 0 ? 'no_platforms'
    // A full plan needs nothing — credits, cap and trends only matter for the gap.
    : !gap ? null
    : 'blocked' in next ? next.blocked
    // run.ts writes nothing without a trend to write about; the hourly refresh usually fixes this by itself.
    : s.enabled && !freshTrend ? 'no_trends'
    : null;
  const plan = planGap(weeklyTarget(s), horizonDays, planned, now, s.enabled && !blocked);
  return {
    enabled: s.enabled,
    blocked,
    mode: s.autoPublishThreshold <= 100 ? 'auto' : 'review',
    threshold: s.autoPublishThreshold,
    horizonDays,
    planned,
    target: plan.target,
    ready: (plannedDrafts?.inWindow ?? 0) + (queuedDrafts?.n ?? 0),
    creditsThisWeek: period.creditsThisWeek,
    nextTopUpAt: plan.nextTopUpAt,
    dueNow: !blocked && plan.gap,
    balance,
    pendingReview: pendingReview.map(({ videoJobId, ...d }) => ({ ...d, rendering: !!videoJobId })),
    nextPostAt: nextPost ? new Date(nextPost.at).toISOString() : null,
  };
}
