import { and, eq, desc, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  agentSettings,
  trends,
  drafts,
  connectedAccounts,
  activityLog,
  type Platform,
  type DraftMedia,
  type Niche,
  type VoiceTemplate,
} from '../db/schema';
import { draftFromTrends } from '../ai/agent';
import { renderBrandBlock } from '../ai/brand-context';
import { charge, getBalance } from '../credits/ledger';
import { CREDIT_PRICES } from '../credits/pricing';
import { draftCost } from '../credits/estimator';
import { postKind, supportsKind, type PostKind } from '../platforms/capabilities';
import { loadWeek, nextDraftDue, kindQueue, affordableKind, weeklyTarget } from './status';
import { generateAgentImage, submitAgentVideo } from './media';
import { publishOrHold } from './publish';

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

  // Autopilot paused = the agent does nothing on its own. `force` (the manual
  // "Auto-draft from trends" button) may still draft, but a paused agent never
  // schedules a live post — publishOrHold checks `enabled` itself.
  if (!settings.enabled && !opts?.force) {
    return { userId, drafted: 0, published: 0, held: 0, reason: 'disabled' };
  }

  const accounts = await db()
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, userId));
  const connectedPlatforms = Array.from(new Set(accounts.map((a) => a.platform))) as Platform[];
  if (((settings.niches ?? []) as Niche[]).length === 0) return blocked(userId, 'no_niches', 'no_niches');
  if (connectedPlatforms.length === 0) return blocked(userId, 'no_accounts', 'no_platforms');

  // `enabledPlatforms` is an explicit allow-list: empty means NO platforms,
  // never "all connected". The UI says the same thing ("Autopilot has nowhere
  // to post"), and [] is the column default, so the old "empty = all" reading
  // posted to every connected account of every user who never finished
  // onboarding. Per-platform weekly caps are enforced in publishOrHold.
  const allowList = (settings.enabledPlatforms ?? []) as Platform[];
  const allowedPlatforms = connectedPlatforms.filter((p) => allowList.includes(p));
  if (allowedPlatforms.length === 0) return blocked(userId, 'no_allowed_platforms', 'no_platforms');

  // The manual button (`force`) is the user asking for drafts right now: it
  // skips pacing and the weekly cap, and stays text-only so one click can never
  // spend a video's worth of credits.
  let kind: PostKind = 'text';
  const balance = await getBalance(userId);
  if (opts?.force) {
    if (balance < draftCost('text') * 2) return blocked(userId, 'insufficient_credits', 'no_credits');
  } else {
    const week = await loadWeek(userId);
    const target = weeklyTarget(settings);
    const due = nextDraftDue(target, week.draftTimes);
    if (!due || due > new Date()) {
      const spent = week.draftTimes.length >= target;
      return { userId, drafted: 0, published: 0, held: 0, reason: spent ? 'budget_met' : 'not_due' };
    }
    const mix = settings.postsPerWeekByContentType ?? { text: target, image: 0, video: 0 };
    const next = affordableKind(kindQueue(mix, week.done, allowedPlatforms), balance, settings.weeklyCreditCap, week.creditsThisWeek);
    if ('blocked' in next) {
      return blocked(userId, next.blocked === 'no_credits' ? 'insufficient_credits' : next.blocked, next.blocked);
    }
    kind = next.kind;
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

  // Claim this run before the slow part (LLM + image can take 90s). Without it
  // two runs that overlap — the enable-kick and a cron tick, or a doubled cron —
  // both see "due", both draft, and the user pays twice. Whoever updates the
  // row first wins; the manual button is the user's own choice and skips this.
  if (!opts?.force) {
    const claimed = await db()
      .update(agentSettings)
      .set({ lastRunAt: new Date() })
      .where(and(
        eq(agentSettings.userId, userId),
        or(isNull(agentSettings.lastRunAt), lt(agentSettings.lastRunAt, new Date(Date.now() - 15 * 60_000))),
      ))
      .returning({ userId: agentSettings.userId });
    if (claimed.length === 0) return { userId, drafted: 0, published: 0, held: 0, reason: 'already_running' };
  }

  // Who the brand is. Built from the row already in hand; voice, style guide,
  // niches and safety are blanked because the agent prompt states them itself.
  const brandBlock = renderBrandBlock(
    {
      companyName: settings.companyName,
      brandBio: settings.brandBio,
      website: settings.website,
      brandBrief: settings.brandBrief,
      niches: [],
      voiceTemplate: null,
      instructions: null,
      brandSafetyStrict: false,
    },
    'text',
  );
  const drafted = await draftFromTrends({
    userId,
    instructions: settings.instructions,
    voiceTemplate: (settings.voiceTemplate ?? 'me') as VoiceTemplate,
    niches: (settings.niches ?? []) as Niche[],
    platforms: allowedPlatforms,
    brandSafetyStrict: settings.brandSafetyStrict,
    brandBlock,
    trends: newTrends.map((t) => ({ id: t.id, niche: t.niche, title: t.title, summary: t.summary, sourceUrl: t.sourceUrl })),
    // One per cron tick: nextDraftDue spreads the week's drafts out.
    count: opts?.force ? 2 : 1,
  });

  let publishedCount = 0;
  let heldCount = 0;
  const draftIds: string[] = [];

  for (const d of drafted) {
    // Media first, so the draft row is written complete. A failed image or a
    // render that won't start has already been refunded — the post carries on
    // as text rather than being thrown away.
    let media: DraftMedia[] = [];
    let videoJobId: string | null = null;
    try {
      const post = { userId, title: d.title, body: d.body, brandBlock };
      if (kind === 'image') media = [await generateAgentImage(post)].filter((m): m is DraftMedia => !!m);
      if (kind === 'video') videoJobId = await submitAgentVideo(post);
    } catch (e) {
      console.warn(`[agent.run] ${kind} generation failed:`, e instanceof Error ? e.message : e);
    }

    const [draftRow] = await db()
      .insert(drafts)
      .values({
        userId,
        title: d.title,
        body: d.body,
        variants: [{ label: 'A', text: d.body, score: d.score, rationale: d.rationale }],
        selectedVariantLabel: 'A',
        media,
        videoJobId,
        // Only platforms that can publish what this turned out to be — a failed
        // image leaves a text post, which Instagram would reject.
        targetPlatforms: allowedPlatforms.filter((p) => supportsKind(p, videoJobId ? 'video' : postKind(media))),
        perPlatformText: d.perPlatform,
        source: 'agent',
      })
      .returning();
    draftIds.push(draftRow.id);

    // Best-effort — if the charge fails (db hiccup), we don't block the user
    // from getting their draft. `via`, not `source`: meta.source is uniquely
    // indexed per user for idempotency, so tagging every draft with the same
    // source charged the first one and silently failed every one after it.
    try {
      await charge({
        userId,
        action: 'agent_draft',
        credits: CREDIT_PRICES.agent_draft,
        meta: { draftId: draftRow.id, via: 'autopilot' },
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

    // A video post waits for its render; attachFinishedVideos makes the
    // schedule-or-hold call when the clip lands.
    if (videoJobId) {
      await db().insert(activityLog).values({
        userId,
        kind: 'agent_drafted',
        title: `Agent drafted: ${d.title}`,
        body: 'Rendering the video now — usually a few minutes. ' + d.body.slice(0, 200),
        meta: { draftId: draftRow.id, score: d.score, videoJobId },
      });
      heldCount++;
    } else {
      // Re-read: the image took a minute, and "pause" or "ask me first" clicked
      // in that minute must win over the snapshot this run started with.
      const [fresh] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
      if (await publishOrHold(fresh ?? settings, draftRow, d.score)) publishedCount++;
      else heldCount++;
    }
  }

  await db().update(agentSettings).set({ lastRunAt: new Date() }).where(eq(agentSettings.userId, userId));
  return { userId, drafted: drafted.length, published: publishedCount, held: heldCount, draftIds };
}

// What the user has to do before autopilot can draft. Shown in the bell and
// the activity feed — the only channel that reaches every user today.
const BLOCKED_NOTES = {
  no_niches: ['Autopilot is waiting on you — no topics picked', 'Pick at least one niche so it knows what to write about. Open Auto-pilot and hit Finish setup.'],
  no_platforms: ['Autopilot is waiting on you — nowhere to post', 'Connect an account, then switch it on under Auto-pilot → Autopilot rules. Nothing is drafted until one is on.'],
  no_credits: ['Autopilot paused — out of credits', 'There are not enough credits for the next post. Top up or upgrade and it picks up on its own.'],
  credit_cap: ['Autopilot hit your weekly credit cap', 'It resumes as this week\'s spend ages out. Raise the cap on the Auto-pilot page to keep it going now.'],
} as const;

/**
 * Autopilot is on but can't draft. Tell the user once — the cron asks every two
 * hours, and a fresh "you're out of credits" each time buries everything else
 * in the feed. A week later, if it is still stuck, it is worth saying again.
 */
async function blocked(userId: string, reason: string, note: keyof typeof BLOCKED_NOTES): Promise<AgentRunResult> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [told] = await db()
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(eq(activityLog.userId, userId), eq(activityLog.kind, 'agent_skipped'), gte(activityLog.createdAt, since), sql`${activityLog.meta}->>'note' = ${note}`))
    .limit(1);
  if (!told) {
    const [title, body] = BLOCKED_NOTES[note];
    await db().insert(activityLog).values({ userId, kind: 'agent_skipped', title, body, meta: { reason, note } });
  }
  return { userId, drafted: 0, published: 0, held: 0, reason };
}

export async function runAgentForAll(): Promise<AgentRunResult[]> {
  // ponytail: sequential and unbounded. Fine while enabled users number in the
  // dozens; shard by user id across ticks when a tick stops fitting in 2 hours.
  const enabled = await db().select({ userId: agentSettings.userId }).from(agentSettings).where(eq(agentSettings.enabled, true));
  const out: AgentRunResult[] = [];
  for (const { userId } of enabled) {
    try {
      out.push(await runAgentForUser(userId));
    } catch (e) {
      // One user's bad row or provider error must not cost everyone after them their tick.
      console.error('[agent.run]', userId, e instanceof Error ? e.message : e);
      out.push({ userId, drafted: 0, published: 0, held: 0, reason: 'error' });
    }
  }
  return out;
}
