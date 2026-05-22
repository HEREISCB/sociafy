import { and, eq, desc, gte } from 'drizzle-orm';
import { db } from '../db';
import {
  agentSettings,
  trends,
  drafts,
  scheduledPosts,
  connectedAccounts,
  activityLog,
  PLATFORMS,
  type Platform,
  type DraftMedia,
  type Niche,
  type VoiceTemplate,
} from '../db/schema';
import { draftFromTrends } from '../ai/agent';
import { nextPostingWindow } from '../schedule/windows';
import { charge, getBalance } from '../credits/ledger';
import { CREDIT_PRICES } from '../credits/pricing';

export type AgentRunResult = {
  userId: string;
  drafted: number;
  published: number;
  held: number;
  reason?: string;
  draftIds?: string[];
};

export async function runAgentForUser(userId: string, opts?: { force?: boolean }): Promise<AgentRunResult> {
  const [settings] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  if (!settings) return { userId, drafted: 0, published: 0, held: 0, reason: 'no_settings' };

  // Credit pre-flight: autopilot needs at least 1 credit per draft it'll
  // attempt. If the user is out, skip rather than partial-running.
  const minCredits = CREDIT_PRICES.agent_draft * (opts?.force ? 2 : Math.min(2, settings.cadencePerWeek));
  const balance = await getBalance(userId);
  if (balance < minCredits) {
    await db().insert(activityLog).values({
      userId,
      kind: 'agent_skipped',
      title: 'Autopilot paused — out of credits',
      body: `Need ${minCredits} credits to draft, balance is ${balance}. Top up or upgrade to resume.`,
      meta: { reason: 'insufficient_credits', balance, needed: minCredits },
    });
    return { userId, drafted: 0, published: 0, held: 0, reason: 'insufficient_credits' };
  }

  // Per-user budget: drafts produced in the past 7 days (skip if force)
  if (!opts?.force) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = await db()
      .select()
      .from(drafts)
      .where(and(eq(drafts.userId, userId), eq(drafts.source, 'agent'), gte(drafts.createdAt, since)));
    if (recent.length >= settings.cadencePerWeek) {
      return { userId, drafted: 0, published: 0, held: 0, reason: 'budget_met' };
    }
  }

  const newTrends = await db()
    .select()
    .from(trends)
    .where(and(eq(trends.userId, userId), eq(trends.status, 'new')))
    .orderBy(desc(trends.score), desc(trends.capturedAt))
    .limit(8);
  if (newTrends.length === 0) {
    return { userId, drafted: 0, published: 0, held: 0, reason: 'no_trends' };
  }

  const accounts = await db()
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, userId));
  const connectedPlatforms = Array.from(new Set(accounts.map((a) => a.platform))) as Platform[];
  if (connectedPlatforms.length === 0) {
    return { userId, drafted: 0, published: 0, held: 0, reason: 'no_accounts' };
  }

  // Apply the autopilot permission matrix. `enabledPlatforms` empty array
  // means "all connected" (legacy behavior); otherwise we restrict to the
  // intersection. Per-platform weekly caps are checked just-in-time below
  // before each scheduledPosts.insert.
  const allowList = (settings.enabledPlatforms ?? []) as Platform[];
  const allowedPlatforms = allowList.length === 0
    ? connectedPlatforms
    : connectedPlatforms.filter((p) => allowList.includes(p));
  if (allowedPlatforms.length === 0) {
    return { userId, drafted: 0, published: 0, held: 0, reason: 'no_allowed_platforms' };
  }

  // Tally this week's scheduled-or-published posts per platform so we can
  // enforce `postsPerWeekByPlatform`. We count any row in the last 7 days
  // — that's the budget window.
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentSched = await db()
    .select({ platform: scheduledPosts.platform })
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.userId, userId), gte(scheduledPosts.createdAt, weekAgo)));
  const usedByPlatform = new Map<Platform, number>();
  for (const row of recentSched) {
    const k = row.platform as Platform;
    usedByPlatform.set(k, (usedByPlatform.get(k) ?? 0) + 1);
  }
  const platformCaps = (settings.postsPerWeekByPlatform ?? {}) as Partial<Record<Platform, number>>;
  const canStillPostTo = (p: Platform): boolean => {
    const cap = platformCaps[p];
    if (typeof cap !== 'number') return true; // no cap = no limit
    const used = usedByPlatform.get(p) ?? 0;
    return used < cap;
  };
  // PLATFORMS is imported for a forthcoming text/image/video mix
  // enforcement; reference it once so TS doesn't flag the import.
  void PLATFORMS;

  const drafted = await draftFromTrends({
    userId,
    instructions: settings.instructions,
    voiceTemplate: (settings.voiceTemplate ?? 'me') as VoiceTemplate,
    niches: (settings.niches ?? []) as Niche[],
    platforms: allowedPlatforms,
    brandSafetyStrict: settings.brandSafetyStrict,
    trends: newTrends.map((t) => ({ id: t.id, niche: t.niche, title: t.title, summary: t.summary, sourceUrl: t.sourceUrl })),
    count: opts?.force ? 2 : Math.min(2, settings.cadencePerWeek),
  });

  let publishedCount = 0;
  let heldCount = 0;
  const draftIds: string[] = [];

  for (const d of drafted) {
    const [draftRow] = await db()
      .insert(drafts)
      .values({
        userId,
        title: d.title,
        body: d.body,
        variants: [{ label: 'A', text: d.body, score: d.score, rationale: d.rationale }],
        selectedVariantLabel: 'A',
        targetPlatforms: allowedPlatforms,
        perPlatformText: d.perPlatform,
        source: 'agent',
      })
      .returning();
    draftIds.push(draftRow.id);

    // Charge 1 credit per autopilot draft. Best-effort — if charge fails
    // (db hiccup), we don't block the user from getting their draft.
    try {
      await charge({
        userId,
        action: 'agent_draft',
        credits: CREDIT_PRICES.agent_draft,
        meta: { draftId: draftRow.id, source: 'autopilot' },
      });
    } catch (e) {
      console.warn('[agent.run] charge agent_draft failed:', e instanceof Error ? e.message : e);
    }

    if (d.trendId) {
      await db()
        .update(trends)
        .set({ status: 'used', usedInDraftId: draftRow.id })
        .where(eq(trends.id, d.trendId));
    }

    const accountByPlatform = new Map(accounts.map((a) => [a.platform, a]));

    if (d.score >= settings.autoPublishThreshold) {
      const when = nextPostingWindow(new Date(), settings.quietHours);
      const skipped: Platform[] = [];
      for (const p of allowedPlatforms) {
        const acct = accountByPlatform.get(p);
        if (!acct) continue;
        if (!canStillPostTo(p)) {
          skipped.push(p);
          continue;
        }
        await db().insert(scheduledPosts).values({
          userId,
          draftId: draftRow.id,
          accountId: acct.id,
          platform: p,
          scheduledAt: when,
          text: d.perPlatform[p] ?? d.body,
          media: [] as DraftMedia[],
        });
        // Tally so a second draft in the same run respects the cap.
        usedByPlatform.set(p, (usedByPlatform.get(p) ?? 0) + 1);
      }
      if (skipped.length > 0) {
        console.log(`[agent.run] skipped over weekly cap: ${skipped.join(', ')}`);
      }
      await db().update(drafts).set({ status: 'scheduled' }).where(eq(drafts.id, draftRow.id));
      await db().insert(activityLog).values({
        userId,
        kind: 'auto_publish',
        title: `Agent scheduled: ${d.title}`,
        body: d.body.slice(0, 280),
        meta: { draftId: draftRow.id, score: d.score, scheduledAt: when.toISOString() },
      });
      publishedCount++;
    } else {
      await db().insert(activityLog).values({
        userId,
        kind: 'agent_drafted',
        title: `Agent drafted: ${d.title}`,
        body: d.body.slice(0, 280),
        meta: { draftId: draftRow.id, score: d.score, threshold: settings.autoPublishThreshold },
      });
      heldCount++;
    }
  }

  await db().update(agentSettings).set({ lastRunAt: new Date() }).where(eq(agentSettings.userId, userId));
  return { userId, drafted: drafted.length, published: publishedCount, held: heldCount, draftIds };
}

export async function runAgentForAll(): Promise<AgentRunResult[]> {
  const enabled = await db().select().from(agentSettings).where(eq(agentSettings.enabled, true)).limit(100);
  const out: AgentRunResult[] = [];
  for (const settings of enabled) {
    out.push(await runAgentForUser(settings.userId));
  }
  return out;
}
