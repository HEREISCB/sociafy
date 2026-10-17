/**
 * Hybrid videos: AI footage rendered first, then composited inside an AI motion
 * graphic by the motion-ai worker (docs/video-brain.md §3).
 *
 * Money:
 *  - The whole hybrid price is charged ONCE, up front, on the parent row (the
 *    user-facing motion-claude job). The footage is an internal child row with
 *    credits_charged 0; its render cost is ours whatever happens.
 *  - Parent waits in HYBRID_WAITING (not 'pending', so finalizers and slot
 *    counts ignore it). When the child completes, the parent is claimed
 *    (conditional UPDATE → HYBRID_SUBMITTING, so exactly one caller submits)
 *    and handed to the worker with the child's R2 url as footage.
 *  - Footage failed/refused → the plan's fallback: the parent renders as a plain
 *    AI motion graphic and the user pays only the fallback price (see fallback()).
 *    That submit failing too → parent failed, full refund.
 *  - Once 'pending' with a task id, the parent is an ordinary motion-claude row:
 *    finalizeVideoJob stores it or fails + refunds it (incl. `footage_failed`).
 *  - Parent stuck past MAX_AGE_MS in either hybrid state → failed, full refund.
 *
 * Driven from two places: the poller (GET /api/media/video-job/[id]) and the
 * cron sweep (advanceHybrids, from lib/cron/finalizeJobs.ts).
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { hybridParts, mediaAssets, videoJobs } from '../db/schema';
import { charge, ensureBalance, refund, InsufficientCreditsError } from '../credits/ledger';
import { backendFor, MOTION_AI } from '../ai/models';
import { createSeedanceTask, type SeedanceMode } from '../ai/piapi';
import { submitMotionAi, type MotionAudioRequest, type MotionFootage } from '../ai/motionAi';
import { motionAiReady } from '../brand/kit';
import { makeMediaKey } from '../storage/r2';
import { priceForPlan, type Plan, type Recipe } from '../ai/videoBrain';
import { AMBIGUOUS_SUBMIT_RX, MotionNotReady, loadBrand, motionAiBrand } from './motionJob';
import { finalizeVideoJob, HYBRID_SUBMITTING, HYBRID_WAITING, MAX_AGE_MS } from './finalizeVideoJob';

type VideoJob = typeof videoJobs.$inferSelect;

/** Stored on hybrid_parts.spec: everything the parent needs to submit later. */
export type HybridSpec = {
  prompt: string;
  audio: MotionAudioRequest;
  clip: { label: string; startSec: number; durationSec: number };
  /** AI motion price of the same video without footage: what the fallback costs. */
  fallbackCredits: number;
  via: string;
};

const LAYOUT: Record<Exclude<Recipe, 'H5'>, { start: number; label: string; hint: string }> = {
  H1: { start: 2, label: 'Scene', hint: 'open with a 2 s kinetic hook, then play the footage with a 3-6 word caption bar, then close on an end card' },
  H2: { start: 0, label: 'B-roll', hint: 'play the footage full-bleed from the start under a 35-45% brand-color scrim with the numbers counting up on top, then an end card' },
  H3: { start: 0, label: 'Product', hint: 'open on the product footage, then spec or price chips over its held last frame, then a call-to-action end card' },
  H4: { start: 1, label: 'Footage card', hint: 'show the footage inside a rounded card (about 60% of the canvas) while big type animates beside or above it, then an end card' },
};

const SEEDANCE_MODE: Record<string, SeedanceMode> = { text: 'text_to_video', 'image-to-video': 'first_last_frames', reference: 'omni_reference' };

/** Build the parent's spec from a validated hybrid plan. Pure. */
export function hybridSpec(plan: Plan, topic: string, via: string, fallbackCredits: number): HybridSpec {
  const f = plan.footage!;
  const layout = LAYOUT[(plan.recipe ?? 'H1') as keyof typeof LAYOUT] ?? LAYOUT.H1;
  const durationSec = Math.min(f.seconds, plan.durationSec);
  const startSec = Math.max(0, Math.min(layout.start, plan.durationSec - durationSec));
  const text = plan.onScreenText.length ? `\n\nOn-screen text to feature: ${plan.onScreenText.join(' | ')}` : '';
  return {
    prompt: `${topic.trim()}${text}\n\nLayout: ${layout.hint}.`.slice(0, 4_000),
    audio: { narration: plan.audio.narration, sfx: plan.audio.sfx, music: plan.audio.music },
    clip: { label: layout.label, startSec, durationSec },
    fallbackCredits,
    via,
  };
}

/**
 * Start a hybrid: parent row → child row → link → charge → footage submit.
 * Everything that can fail for a reason that isn't money (brand kit, the link
 * table) happens before the charge, so those failures cost nothing.
 */
export async function startHybrid(args: {
  userId: string;
  plan: Plan;
  topic: string;
  /** Re-hosted stills for image-to-video / reference footage. */
  imageUrls?: string[];
  via: string;
}): Promise<{ job: VideoJob; creditsCharged: number }> {
  const { userId, plan } = args;
  const f = plan.footage;
  if (plan.format !== 'hybrid' || !f || f.engine === 'cinema-1') throw new Error('not_a_hybrid');
  const { kit, profile } = await loadBrand(userId);
  if (!motionAiReady(kit, profile)) throw new MotionNotReady();

  const credits = priceForPlan(plan);
  const fallbackCredits = plan.fallback?.estimatedCredits ?? 0;
  const pre = await ensureBalance(userId, credits);
  if (!pre.ok) throw new InsufficientCreditsError(pre.balance, pre.needed);
  const spec = hybridSpec(plan, args.topic, args.via, fallbackCredits);
  const fast = f.engine === 'motion-1-fast';
  const mode = f.mode !== 'text' && args.imageUrls?.length ? f.mode : 'text';

  const [parent] = await db().insert(videoJobs).values({
    userId, provider: MOTION_AI.backend, providerTaskId: '', status: HYBRID_WAITING,
    prompt: args.topic.slice(0, 2_000), rewrittenPrompt: null,
    durationSec: plan.durationSec, aspect: plan.aspect, quality: '1080p', genMode: 'motion-ai-hybrid',
  }).returning();
  const [child] = await db().insert(videoJobs).values({
    userId, provider: backendFor('sociafy-motion-1', fast), providerTaskId: '', status: 'pending',
    prompt: f.prompt.slice(0, 2_000), rewrittenPrompt: null,
    durationSec: f.seconds, aspect: plan.aspect, quality: f.quality, genMode: mode, creditsCharged: 0,
  }).returning();
  const closeBoth = (error: string) => db().update(videoJobs)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(inArray(videoJobs.id, [parent.id, child.id]));

  let charged;
  try {
    await db().insert(hybridParts).values({ parentJobId: parent.id, childJobId: child.id, role: 'footage', spec });
    charged = await charge({
      userId, action: 'video_motion_ai', credits,
      meta: { videoJobId: parent.id, template: 'ai', hybrid: true, recipe: plan.recipe, footageSec: f.seconds, footageJobId: child.id, aspect: plan.aspect, durationSec: plan.durationSec, via: args.via },
    });
  } catch (e) {
    await closeBoth(e instanceof InsufficientCreditsError ? 'charge_failed' : 'prepare_failed');
    throw e;
  }
  const [live] = await db().update(videoJobs)
    .set({ creditLedgerId: charged.ledgerId, creditsCharged: credits, updatedAt: new Date() })
    .where(eq(videoJobs.id, parent.id))
    .returning();

  try {
    const taskId = await createSeedanceTask({
      prompt: f.prompt, mode: SEEDANCE_MODE[mode], imageUrls: mode === 'text' ? undefined : mode === 'image-to-video' ? args.imageUrls!.slice(0, 1) : args.imageUrls,
      durationSec: f.seconds, aspect: plan.aspect, resolution: f.quality, fast, apiKey: process.env.PIAPI_API_KEY!,
    });
    await db().update(videoJobs).set({ providerTaskId: taskId, updatedAt: new Date() }).where(eq(videoJobs.id, child.id));
  } catch (e) {
    // The footage failing is not the request failing: the parent falls back to
    // a plain motion graphic on the next poll/sweep. An ambiguous submit stays
    // pending and the finalizer gives up on it after its grace window.
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const ambiguous = AMBIGUOUS_SUBMIT_RX.test(msg);
    await db().update(videoJobs)
      .set(ambiguous ? { error: `submit_unconfirmed: ${msg.slice(0, 160)}`, updatedAt: new Date() } : { status: 'failed', error: `submit_failed: ${msg.slice(0, 200)}`, updatedAt: new Date() })
      .where(eq(videoJobs.id, child.id));
  }
  return { job: live, creditsCharged: credits };
}

/** HYBRID_WAITING → HYBRID_SUBMITTING. Only one caller ever gets true. */
async function claim(parent: VideoJob): Promise<boolean> {
  const rows = await db().update(videoJobs)
    .set({ status: HYBRID_SUBMITTING, updatedAt: new Date() })
    .where(and(eq(videoJobs.id, parent.id), eq(videoJobs.status, HYBRID_WAITING)))
    .returning({ id: videoJobs.id });
  return rows.length > 0;
}

/** Fail a parent still in a hybrid state and refund its current charge. Conditional, so once only. */
async function failHybrid(job: VideoJob, error: string): Promise<void> {
  const rows = await db().update(videoJobs)
    .set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(videoJobs.id, job.id), inArray(videoJobs.status, [HYBRID_WAITING, HYBRID_SUBMITTING])))
    .returning({ id: videoJobs.id });
  if (rows.length && job.creditLedgerId) {
    try {
      await refund({ userId: job.userId, ledgerId: job.creditLedgerId, reason: error.slice(0, 120), meta: { videoJobId: job.id } });
    } catch (e) {
      console.warn('[hybrid] refund failed:', e instanceof Error ? e.message : e);
    }
  }
}

/** Hand a claimed parent to the worker. From here it is an ordinary motion-claude row. */
async function submitClaimed(job: VideoJob, spec: HybridSpec, footage?: MotionFootage[]): Promise<void> {
  const { kit, profile } = await loadBrand(job.userId);
  try {
    const { callId } = await submitMotionAi({
      prompt: spec.prompt, aspect: job.aspect as '9:16' | '16:9' | '1:1', durationSec: job.durationSec,
      brand: motionAiBrand(kit, profile), audio: spec.audio, ...(footage ? { footage } : {}),
      videoKey: makeMediaKey(job.userId, footage ? 'motion-ai-hybrid.mp4' : 'motion-ai.mp4'),
      posterKey: makeMediaKey(job.userId, footage ? 'motion-ai-hybrid-poster.jpg' : 'motion-ai-poster.jpg'),
    });
    await db().update(videoJobs).set({ status: 'pending', providerTaskId: callId, updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (AMBIGUOUS_SUBMIT_RX.test(msg)) {
      // The worker may have taken it. Hand it to the finalizer as task-id-less:
      // its grace window (already past, from createdAt) fails + refunds it.
      // ponytail: if the worker did take it we pay for a render we refunded; add a submit idempotency key to the worker if this shows up.
      await db().update(videoJobs).set({ status: 'pending', error: `submit_unconfirmed: ${msg.slice(0, 160)}`, updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
      return;
    }
    await failHybrid(job, `submit_failed: ${msg.slice(0, 200)}`);
  }
}

/**
 * Footage failed: render the same video without it, at the fallback price.
 *
 * Refund the hybrid charge in full, then charge the fallback — rather than a
 * partial refund of the difference — because the ledger allows ONE refund per
 * charge: after a partial refund, a later failure of the fallback render could
 * not refund the rest. Net effect for the user is the same: they pay the fallback.
 *
 * ponytail: a crash between the refund and re-pointing creditLedgerId leaves the
 * fallback charge unlinked (the stuck sweep refunds the already-refunded hybrid
 * charge, a no-op). Narrow window; a ledger-level transfer would close it.
 */
async function fallback(parent: VideoJob, spec: HybridSpec): Promise<void> {
  if (!parent.creditLedgerId || !(spec.fallbackCredits > 0)) return failHybrid(parent, 'footage_failed');
  if (!(await claim(parent))) return;
  // Throws → the row stays HYBRID_SUBMITTING and the stuck sweep refunds it (refund is idempotent).
  await refund({ userId: parent.userId, ledgerId: parent.creditLedgerId, reason: 'hybrid_footage_failed', meta: { videoJobId: parent.id } });
  let charged;
  try {
    charged = await charge({
      userId: parent.userId, action: 'video_motion_ai', credits: spec.fallbackCredits,
      meta: { videoJobId: parent.id, template: 'ai', hybridFallback: true, aspect: parent.aspect, durationSec: parent.durationSec, via: spec.via },
    });
  } catch (e) {
    console.warn('[hybrid] fallback charge failed:', e instanceof Error ? e.message : e);
    // Already fully refunded above; nothing left to return.
    await db().update(videoJobs).set({ status: 'failed', error: 'footage_failed', updatedAt: new Date() }).where(eq(videoJobs.id, parent.id));
    return;
  }
  const [live] = await db().update(videoJobs)
    .set({ creditLedgerId: charged.ledgerId, creditsCharged: spec.fallbackCredits, genMode: 'motion-ai', updatedAt: new Date() })
    .where(eq(videoJobs.id, parent.id))
    .returning();
  await submitClaimed(live, spec);
}

/** Move one hybrid parent forward. Idempotent and safe to call from overlapping polls/sweeps. */
export async function advanceHybrid(parent: VideoJob): Promise<void> {
  if (parent.status !== HYBRID_WAITING && parent.status !== HYBRID_SUBMITTING) return;
  if (Date.now() - parent.createdAt.getTime() > MAX_AGE_MS) return failHybrid(parent, 'provider_stuck');
  if (parent.status === HYBRID_SUBMITTING) return; // another caller is handing it over

  const [link] = await db().select().from(hybridParts).where(eq(hybridParts.parentJobId, parent.id)).limit(1);
  if (!link) return; // nothing to wait on; ages out above
  const spec = link.spec as HybridSpec;
  let [child] = await db().select().from(videoJobs).where(eq(videoJobs.id, link.childJobId)).limit(1);
  if (child?.status === 'pending') {
    await finalizeVideoJob(child);
    [child] = await db().select().from(videoJobs).where(eq(videoJobs.id, link.childJobId)).limit(1);
  }
  if (child?.status === 'pending') return;

  if (child?.status === 'completed' && child.mediaAssetId) {
    const [asset] = await db().select({ publicUrl: mediaAssets.publicUrl }).from(mediaAssets).where(eq(mediaAssets.id, child.mediaAssetId)).limit(1);
    if (asset?.publicUrl?.startsWith('https://')) {
      if (!(await claim(parent))) return;
      return submitClaimed(parent, spec, [{ url: asset.publicUrl, label: spec.clip.label, startSec: spec.clip.startSec, durationSec: spec.clip.durationSec }]);
    }
  }
  return fallback(parent, spec);
}

/** Cron: advance every waiting hybrid, oldest-touched first. */
export async function advanceHybrids(limit = 10): Promise<number> {
  const rows = await db().select().from(videoJobs)
    .where(inArray(videoJobs.status, [HYBRID_WAITING, HYBRID_SUBMITTING]))
    .orderBy(asc(videoJobs.updatedAt))
    .limit(limit);
  for (const row of rows) {
    try {
      await advanceHybrid(row);
      // Rotate the queue so a backlog can't starve newer rows (no-op once the row has moved on).
      await db().update(videoJobs).set({ updatedAt: new Date() }).where(and(eq(videoJobs.id, row.id), eq(videoJobs.status, HYBRID_WAITING)));
    } catch (e) {
      console.error('[hybrid] advance failed', row.id, e instanceof Error ? e.message.slice(0, 300) : e);
    }
  }
  return rows.length;
}
