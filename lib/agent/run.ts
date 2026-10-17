import { and, eq, desc, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  agentSettings,
  trends,
  drafts,
  scheduledPosts,
  connectedAccounts,
  activityLog,
  type Platform,
  type DraftMedia,
  type Niche,
  type VoiceTemplate,
} from '../db/schema';
import { draftFromTrends, type AgentDraft } from '../ai/agent';
import { loadBrandKit, renderBrandBlock } from '../ai/brand-context';
import { charge, getBalance } from '../credits/ledger';
import { CREDIT_PRICES } from '../credits/pricing';
import { draftCost } from '../credits/estimator';
import { postKind, supportsKind, type PostKind } from '../platforms/capabilities';
import { loadWeek, kindQueue, affordableKind, weeklyTarget } from './status';
import { planSlots } from '../schedule/slots';
import { generateAgentImage, submitAgentVideo } from './media';
import { publishOrHold } from './publish';
import { PLAN_MAX } from './plan';

export type AgentRunResult = {
  userId: string;
  drafted: number;
  published: number;
  held: number;
  reason?: string;
  draftIds?: string[];
};

type Settings = typeof agentSettings.$inferSelect;
type Ctx = { userId: string; settings: Settings; platforms: Platform[]; brandBlock: string };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Posts the cron adds per user per tick. Small, so one user's 30-day top-up can't hold the tick for everyone after them. */
const CRON_BATCH = 3;
/** Posts per model call — one call writing 30 posts with per-platform copy would be one slow, fragile reply. */
const CHUNK = 4;
/** How long a plan run holds its lease without a heartbeat. */
const LEASE_MS = 15 * 60_000;

/**
 * Autopilot's entry point (cron, the enable-kick, the manual button).
 * Unforced, it keeps the user's plan filled to their horizon, a few posts per
 * call. `force` (the manual "Auto-draft from trends" button) drafts two text
 * posts now, in the next free plan slots, regardless of plan, pacing and credit cap — but a
 * paused agent still never schedules a live post (publishOrHold checks).
 */
export async function runAgentForUser(userId: string, opts?: { force?: boolean }): Promise<AgentRunResult> {
  const [settings] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  if (!settings) return none(userId, 'no_settings');
  if (!settings.enabled && !opts?.force) return none(userId, 'disabled');
  if (!opts?.force) return planPeriod(userId, { max: CRON_BATCH });

  const ctx = await context(userId, settings);
  if (!('brandBlock' in ctx)) return ctx;
  if ((await getBalance(userId)) < draftCost('text') * 2) return blocked(userId, 'insufficient_credits', 'no_credits');
  // Proposed slots like a plan run's, so they land on days instead of piling
  // up unscheduled. No room in the horizon: they stay unscheduled.
  const now = new Date();
  const [planned, pending] = await Promise.all([
    db().select({ at: drafts.plannedAt }).from(drafts).where(and(eq(drafts.userId, userId), eq(drafts.status, 'draft'), gte(drafts.plannedAt, now))),
    db().select({ at: scheduledPosts.scheduledAt }).from(scheduledPosts).where(and(eq(scheduledPosts.userId, userId), eq(scheduledPosts.status, 'pending'), gte(scheduledPosts.scheduledAt, now))),
  ]);
  const taken = [...planned, ...pending].map((r) => new Date(r.at!));
  const slots = planSlots({ from: now, horizonDays: settings.planHorizonDays ?? 7, count: 2, quiet: settings.quietHours, taken });
  const out = await draftBatch(ctx, ['text', 'text'], [slots[0] ?? null, slots[1] ?? null]);
  await db().update(agentSettings).set({ lastRunAt: new Date() }).where(eq(agentSettings.userId, userId));
  return out;
}

const none = (userId: string, reason: string): AgentRunResult => ({ userId, drafted: 0, published: 0, held: 0, reason });

/** Who and where autopilot posts for — or what the user has to fix first. */
async function context(userId: string, settings: Settings): Promise<Ctx | AgentRunResult> {
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
  const platforms = connectedPlatforms.filter((p) => allowList.includes(p));
  if (platforms.length === 0) return blocked(userId, 'no_allowed_platforms', 'no_platforms');

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
      kit: await loadBrandKit(userId),
    },
    'text',
  );
  return { userId, settings, platforms, brandBlock };
}

/** `lease` is the planRunningUntil this run wrote — its ownership token. */
export type PreparedPlan = { ctx: Ctx; kinds: PostKind[]; slots: Date[]; lease: Date };

/**
 * Fill the user's plan for [now, now + horizon) up to their weekly target ×
 * weeks: decide how many posts are missing, what kind each is (content mix,
 * balance, credit cap scaled to the horizon), and which slot each takes.
 * Holds the plan lease on success — the caller must run fillPlan, which
 * releases it. `max` bounds one call (the cron tops up a few at a time).
 */
export async function preparePlan(userId: string, opts: { horizonDays?: number; max?: number } = {}): Promise<PreparedPlan | AgentRunResult> {
  const [settings] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  if (!settings) return none(userId, 'no_settings');
  const ctx = await context(userId, settings);
  if (!('brandBlock' in ctx)) return ctx;

  // Claim first, read after: a run that finishes between our read and our
  // claim would otherwise leave us drafting against stale counts.
  const now = new Date();
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await db()
    .update(agentSettings)
    .set({ planRunningUntil: lease })
    .where(and(eq(agentSettings.userId, userId), or(isNull(agentSettings.planRunningUntil), lt(agentSettings.planRunningUntil, now))))
    .returning({ userId: agentSettings.userId });
  if (claimed.length === 0) return none(userId, 'already_running');

  try {
    const max = Math.min(opts.max ?? PLAN_MAX, PLAN_MAX);
    const plan = await sizePlan(ctx, opts.horizonDays ?? settings.planHorizonDays ?? 7, max, now);
    if (!('ctx' in plan)) await releaseLease(userId, lease);
    return 'ctx' in plan ? { ...plan, lease } : plan;
  } catch (e) {
    await releaseLease(userId, lease);
    throw e;
  }
}

async function sizePlan(ctx: Ctx, horizonDays: number, max: number, now: Date): Promise<Omit<PreparedPlan, 'lease'> | AgentRunResult> {
  const { userId, settings, platforms } = ctx;
  const end = new Date(now.getTime() + horizonDays * DAY_MS);
  const [planned, pending, balance, spent] = await Promise.all([
    // Every unreviewed planned draft counts, overdue ones too: they get a new
    // slot on approve. A user who never comes back gets one horizon of drafts,
    // not a new batch every week. Recent unplanned agent drafts count too:
    // autopilot drafts from before planning existed have no planned_at.
    db()
      .select({ plannedAt: drafts.plannedAt, media: drafts.media, videoJobId: drafts.videoJobId })
      .from(drafts)
      .where(and(eq(drafts.userId, userId), eq(drafts.status, 'draft'), or(
        isNotNull(drafts.plannedAt),
        and(eq(drafts.source, 'agent'), gte(drafts.createdAt, new Date(now.getTime() - horizonDays * DAY_MS))),
      ))),
    db()
      .select({ draftId: scheduledPosts.draftId, scheduledAt: scheduledPosts.scheduledAt, media: scheduledPosts.media })
      .from(scheduledPosts)
      .where(and(eq(scheduledPosts.userId, userId), eq(scheduledPosts.status, 'pending'), gte(scheduledPosts.scheduledAt, now))),
    getBalance(userId),
    loadWeek(userId, now, horizonDays).then((w) => w.creditsThisWeek),
  ]);

  // What already fills the window: planned drafts + posts already queued in it (one per draft, not per platform).
  const done: Record<PostKind, number> = { text: 0, image: 0, video: 0 };
  for (const d of planned) done[d.videoJobId ? 'video' : postKind(d.media)]++;
  const queued = new Map<string, DraftMedia[] | null>();
  for (const p of pending) if (new Date(p.scheduledAt) < end) queued.set(p.draftId, p.media);
  for (const m of queued.values()) done[postKind(m)]++;

  const weeks = horizonDays / 7;
  const need = Math.min(Math.ceil(weeklyTarget(settings) * weeks) - planned.length - queued.size, max);
  if (need <= 0) return none(userId, 'plan_full');

  // The content mix and the credit cap are per week; a 30-day plan gets 30/7 of each.
  const mix = settings.postsPerWeekByContentType ?? { text: weeklyTarget(settings), image: 0, video: 0 };
  const scaled = { text: mix.text * weeks, image: mix.image * weeks, video: mix.video * weeks };
  const cap = typeof settings.weeklyCreditCap === 'number' ? settings.weeklyCreditCap * weeks : null;
  const kinds: PostKind[] = [];
  let left = balance;
  let used = spent;
  for (let i = 0; i < need; i++) {
    const next = affordableKind(kindQueue(scaled, done, platforms), left, cap, used);
    if ('blocked' in next) {
      if (kinds.length) break;
      return blocked(userId, next.blocked === 'no_credits' ? 'insufficient_credits' : next.blocked, next.blocked);
    }
    kinds.push(next.kind);
    done[next.kind]++;
    left -= draftCost(next.kind);
    used += draftCost(next.kind);
  }

  const taken = [...planned.flatMap((d) => (d.plannedAt ? [d.plannedAt] : [])), ...pending.map((p) => p.scheduledAt)].map((d) => new Date(d));
  const slots = planSlots({ from: now, horizonDays, count: kinds.length, quiet: settings.quietHours, taken });
  if (slots.length === 0) return none(userId, 'plan_full');
  // Videos take the latest slots: their render needs the head start.
  kinds.length = slots.length;
  kinds.sort((a, b) => Number(a === 'video') - Number(b === 'video'));
  return { ctx, kinds, slots };
}

/** Draft the prepared posts, a chunk per model call, then release the lease. */
export async function fillPlan(plan: PreparedPlan): Promise<AgentRunResult> {
  const { userId } = plan.ctx;
  const out: AgentRunResult = { userId, drafted: 0, published: 0, held: 0, draftIds: [] };
  let lease = plan.lease;
  try {
    for (let i = 0; i < plan.kinds.length; i += CHUNK) {
      const r = await draftBatch(plan.ctx, plan.kinds.slice(i, i + CHUNK), plan.slots.slice(i, i + CHUNK));
      out.drafted += r.drafted;
      out.published += r.published;
      out.held += r.held;
      out.draftIds!.push(...(r.draftIds ?? []));
      if (r.reason) { out.reason = r.reason; break; }
      // Heartbeat: a long run (images take a minute each) keeps its lease —
      // only while it still owns it. Lost (it expired and another run claimed
      // it): stop, or two runs draft the same horizon.
      const next = new Date(Date.now() + LEASE_MS);
      const kept = await db()
        .update(agentSettings)
        .set({ planRunningUntil: next })
        .where(and(eq(agentSettings.userId, userId), eq(agentSettings.planRunningUntil, lease)))
        .returning({ userId: agentSettings.userId });
      if (kept.length === 0) { out.reason = 'lease_lost'; return out; }
      lease = next;
    }
  } finally {
    await releaseLease(userId, lease);
  }
  return out;
}

/** Fill the user's plan up to the horizon. Cron, enable-kick and "Generate" all come through here. */
export async function planPeriod(userId: string, opts: { horizonDays?: number; max?: number } = {}): Promise<AgentRunResult> {
  const plan = await preparePlan(userId, opts);
  return 'ctx' in plan ? fillPlan(plan) : plan;
}

/** Release only our own lease: an expired run must not free another run's. */
const releaseLease = (userId: string, lease: Date) =>
  db()
    .update(agentSettings)
    .set({ planRunningUntil: null, lastRunAt: new Date() })
    .where(and(eq(agentSettings.userId, userId), eq(agentSettings.planRunningUntil, lease)));

/**
 * Write one model call's worth of posts: kinds[i] is what post i becomes,
 * slots[i] its planned time (null = unplanned, the manual button).
 */
async function draftBatch(ctx: Ctx, kinds: PostKind[], slots: (Date | null)[]): Promise<AgentRunResult> {
  const { userId, settings, platforms, brandBlock } = ctx;
  const newTrends = await db()
    .select()
    .from(trends)
    .where(and(eq(trends.userId, userId), eq(trends.status, 'new')))
    .orderBy(desc(trends.score), desc(trends.capturedAt))
    .limit(Math.max(8, kinds.length));
  if (newTrends.length === 0) return none(userId, 'no_trends');

  const drafted = await draftFromTrends({
    userId,
    instructions: settings.instructions,
    voiceTemplate: (settings.voiceTemplate ?? 'me') as VoiceTemplate,
    niches: (settings.niches ?? []) as Niche[],
    platforms,
    brandSafetyStrict: settings.brandSafetyStrict,
    brandBlock,
    trends: newTrends.map((t) => ({ id: t.id, niche: t.niche, title: t.title, summary: t.summary, sourceUrl: t.sourceUrl })),
    count: kinds.length,
  });

  const out: AgentRunResult = { userId, drafted: drafted.length, published: 0, held: 0, draftIds: [] };
  for (const [i, d] of drafted.slice(0, kinds.length).entries()) {
    const r = await draftPost(ctx, d, kinds[i], slots[i] ?? null);
    out.draftIds!.push(r.draftId);
    if (r.published) out.published++;
    else out.held++;
  }
  return out;
}

/** One post: media, the draft row (with its planned slot), the charge, then schedule-or-hold. */
async function draftPost(ctx: Ctx, d: AgentDraft, kind: PostKind, plannedAt: Date | null): Promise<{ draftId: string; published: boolean }> {
  const { userId, settings, platforms, brandBlock } = ctx;
  // Media first, so the draft row is written complete. A failed image or a
  // render that won't start has already been refunded — the post carries on
  // as text rather than being thrown away. A render can take many minutes
  // (and wait on provider capacity); attachFinishedVideos picks it up.
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
      // perPlatform snapshot: lets postText tell the model's copy from the user's.
      variants: [{ label: 'A', text: d.body, score: d.score, rationale: d.rationale, perPlatform: d.perPlatform }],
      selectedVariantLabel: 'A',
      media,
      videoJobId,
      plannedAt,
      // Only platforms that can publish what this turned out to be — a failed
      // image leaves a text post, which Instagram would reject.
      targetPlatforms: platforms.filter((p) => supportsKind(p, videoJobId ? 'video' : postKind(media))),
      perPlatformText: d.perPlatform,
      source: 'agent',
    })
    .returning();

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
    return { draftId: draftRow.id, published: false };
  }
  // Re-read: the image took a minute, and "pause" or "ask me first" clicked
  // in that minute must win over the snapshot this run started with.
  const [fresh] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  return { draftId: draftRow.id, published: await publishOrHold(fresh ?? settings, draftRow, d.score) };
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
