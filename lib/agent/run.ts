import { and, eq, desc } from 'drizzle-orm';
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
import type { PostKind } from '../platforms/capabilities';
import { loadWeek, nextDraftDue, kindQueue, affordableKind } from './status';
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
  if (connectedPlatforms.length === 0) {
    return { userId, drafted: 0, published: 0, held: 0, reason: 'no_accounts' };
  }

  // `enabledPlatforms` is an explicit allow-list: empty means NO platforms,
  // never "all connected". The UI says the same thing ("Autopilot has nowhere
  // to post"), and [] is the column default, so the old "empty = all" reading
  // posted to every connected account of every user who never finished
  // onboarding. Per-platform weekly caps are enforced in publishOrHold.
  const allowList = (settings.enabledPlatforms ?? []) as Platform[];
  const allowedPlatforms = connectedPlatforms.filter((p) => allowList.includes(p));
  if (allowedPlatforms.length === 0) {
    return { userId, drafted: 0, published: 0, held: 0, reason: 'no_allowed_platforms' };
  }

  // The manual button (`force`) is the user asking for drafts right now: it
  // skips pacing and the weekly cap, and stays text-only so one click can never
  // spend a video's worth of credits.
  let kind: PostKind = 'text';
  const balance = await getBalance(userId);
  if (opts?.force) {
    if (balance < draftCost('text') * 2) return outOfCredits(userId, balance, draftCost('text') * 2);
  } else {
    const week = await loadWeek(userId);
    const due = nextDraftDue(settings.cadencePerWeek, week.draftTimes);
    if (!due || due > new Date()) {
      const spent = week.draftTimes.length >= settings.cadencePerWeek;
      return { userId, drafted: 0, published: 0, held: 0, reason: spent ? 'budget_met' : 'not_due' };
    }
    const mix = settings.postsPerWeekByContentType ?? { text: settings.cadencePerWeek, image: 0, video: 0 };
    const next = affordableKind(kindQueue(mix, week.done, allowedPlatforms), balance, settings.weeklyCreditCap, week.creditsThisWeek);
    if ('blocked' in next) {
      if (next.blocked === 'no_credits') return outOfCredits(userId, balance, draftCost('text'));
      return { userId, drafted: 0, published: 0, held: 0, reason: next.blocked };
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
        targetPlatforms: allowedPlatforms,
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
    } else if (await publishOrHold(settings, draftRow, d.score)) publishedCount++;
    else heldCount++;
  }

  await db().update(agentSettings).set({ lastRunAt: new Date() }).where(eq(agentSettings.userId, userId));
  return { userId, drafted: drafted.length, published: publishedCount, held: heldCount, draftIds };
}

async function outOfCredits(userId: string, balance: number, needed: number): Promise<AgentRunResult> {
  await db().insert(activityLog).values({
    userId,
    kind: 'agent_skipped',
    title: 'Autopilot paused — out of credits',
    body: `Need ${needed} credits to draft, balance is ${balance}. Top up or upgrade to resume.`,
    meta: { reason: 'insufficient_credits', balance, needed },
  });
  return { userId, drafted: 0, published: 0, held: 0, reason: 'insufficient_credits' };
}

export async function runAgentForAll(): Promise<AgentRunResult[]> {
  const enabled = await db().select().from(agentSettings).where(eq(agentSettings.enabled, true)).limit(100);
  const out: AgentRunResult[] = [];
  for (const settings of enabled) {
    out.push(await runAgentForUser(settings.userId));
  }
  return out;
}
