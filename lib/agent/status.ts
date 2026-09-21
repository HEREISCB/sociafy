import { and, eq, gte, asc, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, drafts, scheduledPosts, creditLedger, connectedAccounts, trends, type Niche, type Platform, type PostsPerWeekByType } from '../db/schema';
import { getBalance } from '../credits/ledger';
import { draftCost } from '../credits/estimator';
import { postKind, supportsKind, type PostKind } from '../platforms/capabilities';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// ponytail: mirrors the agent cron ("0 */2 * * *" in etc/cron.d/sociafy and
// scheduled-jobs.yml). Change the cron, change this — it only drives the
// countdown shown to the user, never whether a draft is allowed.
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

/**
 * When autopilot may next draft. Drafts are spread evenly over the week
 * (4/week = one every 42h) instead of burning the whole weekly budget in the
 * first two cron ticks and then going silent for six days.
 * A date in the past means "due now". Null means autopilot never drafts.
 */
export function nextDraftDue(cadencePerWeek: number, draftTimes: Date[]): Date | null {
  if (cadencePerWeek <= 0) return null;
  if (draftTimes.length === 0) return new Date(0);
  const times = draftTimes.map((d) => d.getTime());
  const paced = Math.max(...times) + WEEK_MS / cadencePerWeek;
  // Weekly budget already spent (manual runs count too): wait for the oldest
  // draft to age out of the 7-day window.
  const budget = times.length >= cadencePerWeek ? Math.min(...times) + WEEK_MS : 0;
  return new Date(Math.max(paced, budget));
}

/** The first cron tick at or after `d` — when a due draft actually gets written. */
export function nextTick(d: Date): Date {
  const t = new Date(d);
  if (t.getUTCMinutes() || t.getUTCSeconds() || t.getUTCMilliseconds()) t.setUTCHours(t.getUTCHours() + 1);
  t.setUTCMinutes(0, 0, 0);
  if (t.getUTCHours() % TICK_HOURS) t.setUTCHours(t.getUTCHours() + 1);
  return t;
}

/** What autopilot has done in the trailing 7 days — the inputs to every pacing decision. */
export async function loadWeek(userId: string, now = new Date()) {
  const since = new Date(now.getTime() - WEEK_MS);
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
  /** Why a due draft would not be written. Null = nothing in the way. */
  blocked: AgentBlock | null;
  /** 'auto' = drafts scoring ≥ threshold post on their own. 'review' = nothing posts without approval. */
  mode: 'auto' | 'review';
  threshold: number;
  /** ISO time of the cron tick that writes the next draft. Null when paused or blocked. */
  nextDraftAt: string | null;
  /** Pacing allows a draft right now — switching on will write one immediately. */
  dueNow: boolean;
  draftsThisWeek: number;
  cadencePerWeek: number;
  creditsThisWeek: number;
  weeklyCreditCap: number | null;
  /** What the next draft will be, and what it costs. Null when blocked. */
  nextKind: PostKind | null;
  nextCost: number;
  /** Credits a full week of this plan costs. */
  weeklyNeed: number;
  balance: number;
  /** Agent drafts still waiting for the user. */
  pendingReview: { id: string; title: string | null; createdAt: Date; rendering: boolean }[];
  /** Earliest post already queued to go out. */
  nextPostAt: string | null;
};

export async function getAgentStatus(userId: string, now = new Date()): Promise<AgentStatus | null> {
  const [s] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  if (!s) return null;
  const [week, balance, connected, [freshTrend], pendingReview, [nextPost]] = await Promise.all([
    loadWeek(userId, now),
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
  ]);

  const mix = s.postsPerWeekByContentType;
  // Same rule as run.ts: a platform counts only if it is switched on AND connected.
  const platforms = ((s.enabledPlatforms ?? []) as Platform[]).filter((p) => connected.some((c) => c.platform === p));
  const next = affordableKind(kindQueue(mix, week.done, platforms), balance, s.weeklyCreditCap, week.creditsThisWeek);
  const blocked: AgentBlock | null =
    ((s.niches ?? []) as Niche[]).length === 0 ? 'no_niches'
    : platforms.length === 0 ? 'no_platforms'
    : 'blocked' in next ? next.blocked
    // run.ts writes nothing without a trend to write about; the hourly refresh usually fixes this by itself.
    : s.enabled && !freshTrend ? 'no_trends'
    : null;

  const target = weeklyTarget(s);
  const due = nextDraftDue(target, week.draftTimes);
  return {
    enabled: s.enabled,
    blocked,
    mode: s.autoPublishThreshold <= 100 ? 'auto' : 'review',
    threshold: s.autoPublishThreshold,
    nextDraftAt: s.enabled && !blocked && due ? nextTick(due > now ? due : now).toISOString() : null,
    dueNow: !blocked && !!due && due <= now,
    draftsThisWeek: week.draftTimes.length,
    cadencePerWeek: target,
    creditsThisWeek: week.creditsThisWeek,
    weeklyCreditCap: s.weeklyCreditCap,
    nextKind: 'kind' in next ? next.kind : null,
    nextCost: 'kind' in next ? draftCost(next.kind) : 0,
    weeklyNeed: (['text', 'image', 'video'] as const).reduce((sum, k) => sum + mix[k] * draftCost(k), 0),
    balance,
    pendingReview: pendingReview.map(({ videoJobId, ...d }) => ({ ...d, rendering: !!videoJobId })),
    nextPostAt: nextPost ? new Date(nextPost.at).toISOString() : null,
  };
}
