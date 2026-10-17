import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, drafts, genJobs, videoJobs, mediaAssets, activityLog, type DraftMedia } from '../db/schema';
import { charge } from '../credits/ledger';
import { priceForImage } from '../credits/pricing';
import { AGENT_IMAGE, AGENT_VIDEO } from '../credits/estimator';
import { rewritePromptForMedia } from '../ai/prompt-rewriter';
import { DEFAULT_VIDEO_MODEL, MOTION_GRAPHICS, backendFor, modelForBackend, type MotionTemplate, type VideoModelId } from '../ai/models';
import { motionConfigured } from '../ai/motion';
import { motionReady } from '../brand/kit';
import { autopilotTemplate, loadBrand, submitMotionVideo } from '../media/motionJob';
// The hardened generation paths live with the public API. Reused rather than
// copied: row → charge → provider, refund-on-failure and the cron sweepers all
// already work on these rows. (lib/cron/finalizeJobs.ts imports from here too.)
import { insertImageJob, runImageJob, failImageJob, submitVideo, SubmitFailure } from '../../app/api/v1/shared';
import { publishOrHold } from './publish';
import { isApproved, queueApprovedRender } from './plan';

type Post = { userId: string; title: string; body: string; brandBlock: string };

const mediaPrompt = (p: Post, target: 'gpt-image-2' | 'seedance-2') =>
  rewritePromptForMedia({ userPrompt: `${p.title}\n\n${p.body}`.slice(0, 1_500), target, caption: p.body, brandBlock: p.brandBlock });

/** Generate the image for an autopilot post. Null = it failed and the charge was refunded. */
export async function generateAgentImage(p: Post): Promise<DraftMedia | null> {
  const { prompt } = await mediaPrompt(p, 'gpt-image-2');
  const job = await insertImageJob(p.userId, { prompt, ...AGENT_IMAGE, referenceCount: 0, source: null });
  try {
    const unit = priceForImage(AGENT_IMAGE.size, AGENT_IMAGE.quality);
    const charged = await charge({
      userId: p.userId,
      action: unit.action,
      credits: unit.credits,
      meta: { via: 'autopilot', imageJobId: job.id, ...AGENT_IMAGE },
    });
    // The sweeper and failImageJob refund against this link — set it in memory
    // first so a failed UPDATE still leaves the catch below able to refund.
    job.creditLedgerId = charged.ledgerId;
    await db().update(genJobs).set({ creditLedgerId: charged.ledgerId, creditsCharged: unit.credits }).where(eq(genJobs.id, job.id));
  } catch (e) {
    await failImageJob(job, 'charge_failed');
    throw e;
  }
  await runImageJob(job, null); // never throws; leaves the row terminal and the money settled
  const [done] = await db().select().from(genJobs).where(eq(genJobs.id, job.id)).limit(1);
  if (!done?.mediaAssetId) return null;
  const [a] = await db().select().from(mediaAssets).where(eq(mediaAssets.id, done.mediaAssetId)).limit(1);
  return a ? { id: a.id, url: a.publicUrl, mimeType: a.mimeType, width: a.width ?? undefined, height: a.height ?? undefined } : null;
}

/**
 * A video_jobs row parked because every render slot was busy. Not 'pending':
 * nothing was charged and nothing is upstream, so the finalizer, the in-flight
 * slot count and the poller must all ignore it. submitQueuedVideos owns it.
 */
export const VIDEO_QUEUED = 'queued';
const VIDEO_SUBMITTING = 'submitting';
/** A queued render that has not found a slot in a day is not going to. */
const QUEUE_MAX_MS = 24 * 60 * 60_000;
/** Parked rows looked at per sweep. */
const SWEEP_BATCH = 12;

/** All slots busy — before the charge (our own count, Cinema only) or after
 *  it (either backend's 429, already refunded by submitVideo). Retry later. */
const isAtCapacity = (e: unknown) =>
  e instanceof SubmitFailure && (e.code === 'at_capacity' || /(piapi|cue)_429/.test(e.detail));

/** `model` is only ever not the default for a row parked before autopilot
 *  moved off Cinema: it renders on what it was queued (and prompted) for. */
const renderAgentVideo = (userId: string, prompt: string, model: VideoModelId = DEFAULT_VIDEO_MODEL) =>
  submitVideo({ auth: { userId }, model, prompt, ...AGENT_VIDEO, source: null, via: 'autopilot' });

/**
 * Start the render for an autopilot video post. Returns the video_jobs id to
 * park on the draft.
 *
 * When the backend is at its concurrency limit (it answers 429), the post is
 * not dropped to text: a VIDEO_QUEUED row is parked instead, uncharged, and
 * the five-minute sweep submits it once a slot frees.
 */
export async function submitAgentVideo(p: Post): Promise<string> {
  const template = await motionTemplateFor(p.userId);
  if (template) {
    const { job } = await submitMotionVideo({
      userId: p.userId, template, aspect: '9:16', topic: `${p.title}\n\n${p.body}`, via: 'autopilot',
    });
    return job.id;
  }
  // Motion is mute, so no Audio: line (that is Cinema's convention).
  const { prompt } = await mediaPrompt(p, 'seedance-2');
  try {
    return (await renderAgentVideo(p.userId, prompt)).job.id;
  } catch (e) {
    if (!isAtCapacity(e)) throw e;
    const [row] = await db()
      .insert(videoJobs)
      .values({
        userId: p.userId,
        provider: backendFor(DEFAULT_VIDEO_MODEL, AGENT_VIDEO.fast),
        providerTaskId: '',
        status: VIDEO_QUEUED,
        prompt,
        durationSec: AGENT_VIDEO.durationSec,
        aspect: AGENT_VIDEO.aspect,
        quality: AGENT_VIDEO.quality,
        genMode: 'text',
      })
      .returning();
    return row.id;
  }
}

/**
 * Motion graphics instead of a generated clip for this slot? Only with the engine
 * configured and a brand kit that can carry it (name + logo + primary color).
 * 'mix' alternates against the user's last video render.
 */
async function motionTemplateFor(userId: string): Promise<MotionTemplate | null> {
  if (!motionConfigured()) return null;
  const { kit, profile } = await loadBrand(userId);
  const style = kit.video?.autopilot ?? 'cinema';
  if (style === 'cinema' || !motionReady(kit, profile)) return null;
  if (style === 'mix') {
    const [last] = await db()
      .select({ provider: videoJobs.provider })
      .from(videoJobs)
      .where(eq(videoJobs.userId, userId))
      .orderBy(desc(videoJobs.createdAt))
      .limit(1);
    if (last?.provider === MOTION_GRAPHICS.backend) return null;
  }
  return autopilotTemplate(kit);
}

/**
 * Submit parked autopilot renders, oldest first, until the slots run out.
 *
 * The parked row only holds the request. A real submit goes through
 * submitVideo (its own row → charge → render, refund on failure), then the
 * draft is repointed at that job and the placeholder deleted — so the money
 * path is exactly the one an immediate submit takes. The placeholder is
 * claimed first so two overlapping sweeps cannot both submit (and charge) it.
 *
 * ponytail: a process that dies between the claim and the repoint leaves the
 * row 'submitting' until QUEUE_MAX_MS fails it (the post then falls back to
 * text; any render that did start still lands in the library).
 */
export async function submitQueuedVideos(): Promise<number> {
  const parked = await db()
    .select()
    .from(videoJobs)
    .where(inArray(videoJobs.status, [VIDEO_QUEUED, VIDEO_SUBMITTING]))
    .orderBy(asc(videoJobs.createdAt))
    .limit(SWEEP_BATCH);

  let submitted = 0;
  for (const q of parked) {
    const fail = (error: string) =>
      db().update(videoJobs).set({ status: 'failed', error, updatedAt: new Date() }).where(eq(videoJobs.id, q.id));

    if (Date.now() - q.createdAt.getTime() > QUEUE_MAX_MS) {
      await fail('queue_timeout');
      continue;
    }
    if (q.status !== VIDEO_QUEUED) continue;

    // Only render for a post that is still waiting on it — a draft the user
    // deleted, scheduled as text or archived must not be billed for a clip.
    const [draft] = await db()
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.videoJobId, q.id), eq(drafts.status, 'draft')))
      .limit(1);
    if (!draft) {
      await fail('abandoned');
      continue;
    }

    const [claimed] = await db()
      .update(videoJobs)
      .set({ status: VIDEO_SUBMITTING, updatedAt: new Date() })
      .where(and(eq(videoJobs.id, q.id), eq(videoJobs.status, VIDEO_QUEUED)))
      .returning({ id: videoJobs.id });
    if (!claimed) continue;

    try {
      const { job } = await renderAgentVideo(q.userId, q.prompt, modelForBackend(q.provider));
      await db().update(drafts).set({ videoJobId: job.id, updatedAt: new Date() }).where(eq(drafts.videoJobId, q.id));
      await db().delete(videoJobs).where(eq(videoJobs.id, q.id));
      submitted++;
    } catch (e) {
      if (isAtCapacity(e)) {
        await db().update(videoJobs).set({ status: VIDEO_QUEUED, updatedAt: new Date() }).where(eq(videoJobs.id, q.id));
        break; // slots are full for everyone behind this one too
      }
      // Nothing was charged against this placeholder; submitVideo has already
      // settled any charge of its own. attachFinishedVideos turns it into text.
      console.warn('[agent.media] queued render failed:', e instanceof Error ? e.message : e);
      await fail('submit_failed');
    }
  }
  return submitted;
}

/**
 * Finish autopilot video drafts whose render has ended: attach the clip and
 * run the normal schedule-or-hold decision, or fall back to a text draft when
 * the render failed (finalizeVideoJob has already refunded it).
 * Runs after the video sweeper, every five minutes.
 */
export async function attachFinishedVideos(): Promise<number> {
  const rows = await db()
    .select({ draft: drafts, job: videoJobs })
    .from(drafts)
    .innerJoin(videoJobs, eq(drafts.videoJobId, videoJobs.id))
    .where(inArray(videoJobs.status, ['completed', 'failed']))
    .limit(50);

  for (const { draft, job } of rows) {
    const [asset] = job.status === 'completed' && job.mediaAssetId
      ? await db().select().from(mediaAssets).where(eq(mediaAssets.id, job.mediaAssetId)).limit(1)
      : [];
    const media: DraftMedia[] = asset
      ? [{ id: asset.id, url: asset.publicUrl, mimeType: asset.mimeType, width: asset.width ?? undefined, height: asset.height ?? undefined }]
      : [];
    // Conditional on the job still being parked here: of two overlapping sweeps
    // only one gets a row back, so a post can never be queued twice. Media the
    // user attached while waiting is theirs — the clip only fills an empty slot.
    const [updated] = await db()
      .update(drafts)
      .set({ ...((draft.media ?? []).length === 0 ? { media } : {}), videoJobId: null, updatedAt: new Date() })
      .where(and(eq(drafts.id, draft.id), eq(drafts.videoJobId, job.id)))
      .returning();
    if (!updated) continue;
    // Scheduled, published or archived by hand in the meantime: their call stands.
    if (updated.status !== 'draft') continue;

    if (!asset) {
      await db().insert(activityLog).values({
        userId: draft.userId,
        kind: 'agent_held',
        title: `Video didn't render: ${draft.title}`,
        body: 'The clip failed and its credits were refunded. The post is in your drafts as text — add media or schedule it as is.',
        meta: { draftId: draft.id, videoJobId: job.id },
      });
      continue;
    }
    const [settings] = await db().select().from(agentSettings).where(eq(agentSettings.userId, draft.userId)).limit(1);
    // Approved while rendering: the user already said yes — schedule it, don't re-review.
    if (isApproved(updated)) await queueApprovedRender(updated, settings?.quietHours);
    else if (settings) await publishOrHold(settings, updated, draft.variants?.[0]?.score ?? 0);
  }
  return rows.length;
}
