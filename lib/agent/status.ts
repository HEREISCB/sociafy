import { and, eq, gte, asc } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, drafts, scheduledPosts, creditLedger, connectedAccounts, type Niche, type Platform } from '../db/schema';
import { getBalance } from '../credits/ledger';
import { CREDIT_PRICES } from '../credits/pricing';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// ponytail: mirrors the agent cron ("0 */2 * * *" in etc/cron.d/sociafy and
// scheduled-jobs.yml). Change the cron, change this — it only drives the
// countdown shown to the user, never whether a draft is allowed.
const TICK_HOURS = 2;

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
    .select({ createdAt: drafts.createdAt })
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.source, 'agent'), gte(drafts.createdAt, since)));
  const spent = await db()
    .select({ credits: creditLedger.credits })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.action, 'agent_draft'), gte(creditLedger.createdAt, since)));
  return {
    draftTimes: recent.map((r) => new Date(r.createdAt)),
    // Charges are negative rows; refunds carry no action, so this is gross spend.
    creditsThisWeek: spent.reduce((s, r) => s - Math.min(0, r.credits), 0),
  };
}

export type AgentBlock = 'no_niches' | 'no_platforms' | 'no_credits' | 'credit_cap';

export type AgentStatus = {
  enabled: boolean;
  /** Why a due draft would not be written. Null = nothing in the way. */
  blocked: AgentBlock | null;
  /** 'auto' = drafts scoring ≥ threshold post on their own. 'review' = nothing posts without approval. */
  mode: 'auto' | 'review';
  threshold: number;
  /** ISO time of the cron tick that writes the next draft. Null when paused or blocked. */
  nextDraftAt: string | null;
  draftsThisWeek: number;
  cadencePerWeek: number;
  creditsThisWeek: number;
  weeklyCreditCap: number | null;
  creditsPerDraft: number;
  balance: number;
  /** Agent drafts still waiting for the user. */
  pendingReview: { id: string; title: string | null; createdAt: Date }[];
  /** Earliest post already queued to go out. */
  nextPostAt: string | null;
};

export async function getAgentStatus(userId: string, now = new Date()): Promise<AgentStatus | null> {
  const [s] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  if (!s) return null;
  const [week, balance, connected, pendingReview, [nextPost]] = await Promise.all([
    loadWeek(userId, now),
    getBalance(userId),
    db().select({ platform: connectedAccounts.platform }).from(connectedAccounts).where(eq(connectedAccounts.userId, userId)),
    db()
      .select({ id: drafts.id, title: drafts.title, createdAt: drafts.createdAt })
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

  const price = CREDIT_PRICES.agent_draft;
  const blocked: AgentBlock | null =
    ((s.niches ?? []) as Niche[]).length === 0 ? 'no_niches'
    // Same rule as run.ts: a platform counts only if it is switched on AND connected.
    : !((s.enabledPlatforms ?? []) as Platform[]).some((p) => connected.some((c) => c.platform === p)) ? 'no_platforms'
    : balance < price ? 'no_credits'
    : overCap(s.weeklyCreditCap, week.creditsThisWeek) ? 'credit_cap'
    : null;

  const due = nextDraftDue(s.cadencePerWeek, week.draftTimes);
  return {
    enabled: s.enabled,
    blocked,
    mode: s.autoPublishThreshold <= 100 ? 'auto' : 'review',
    threshold: s.autoPublishThreshold,
    nextDraftAt: s.enabled && !blocked && due ? nextTick(due > now ? due : now).toISOString() : null,
    draftsThisWeek: week.draftTimes.length,
    cadencePerWeek: s.cadencePerWeek,
    creditsThisWeek: week.creditsThisWeek,
    weeklyCreditCap: s.weeklyCreditCap,
    creditsPerDraft: price,
    balance,
    pendingReview,
    nextPostAt: nextPost ? new Date(nextPost.at).toISOString() : null,
  };
}

/** True when one more draft would push this week's autopilot spend past the user's cap. */
export function overCap(cap: number | null | undefined, creditsThisWeek: number): boolean {
  return typeof cap === 'number' && creditsThisWeek + CREDIT_PRICES.agent_draft > cap;
}
