import { and, eq, ne, notInArray } from 'drizzle-orm';
import { db } from '../db';
import { videoJobs, mediaAssets } from '../db/schema';
import { getSeedanceTask } from '../ai/piapi';
import { CueError, deleteCueRender, downloadCueRender, getCueRender } from '../ai/cue';
import { getMotionResult, motionConfigured } from '../ai/motion';
import { getMotionAiResult, motionAiConfigured, type MotionAiResult, type MotionAudio } from '../ai/motionAi';
import { motionAiExtraMin } from '../ai/models';
import { cleanAudio, saveMotionResult, savedAudioWarning } from './motionVersions';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../storage/r2';
import { downloadToBuffer } from './finalize';
import { posterUrls, savePoster } from './posters';
import { refund } from '../credits/ledger';
import { isStubMode } from '../env';

/**
 * Reconcile one video_jobs row against PiAPI: poll, store the finished MP4 in
 * R2, or fail + refund. The ONLY place this happens — the client-driven poller
 * (`/api/media/video-job/[jobId]`) and the cron sweeper
 * (`/api/cron/finalize-video-jobs`) both call this, so a closed browser tab
 * can't strand a job we already paid the provider for.
 *
 * Concurrency-safe: the transition to 'completed' is a conditional UPDATE and
 * only the caller that actually claims the row writes the media_assets row.
 * Two overlapping polls therefore produce one asset, not two, and the failure
 * path refunds once. The claim and the asset commit in one transaction, so no
 * reader can see 'completed' before the asset it needs exists.
 */

export type VideoJob = typeof videoJobs.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;

export type FinalizeVideoResult =
  | { status: 'pending'; providerStatus?: string; pollError?: string }
  | { status: 'completed'; asset?: MediaAsset & { posterUrl?: string }; rewrittenPrompt?: string | null; /** AI-designed motion: asked-for audio that didn't make it in. */ audioWarning?: MotionAudio['warning'] }
  | { status: 'failed'; error: string };

/** A submit whose socket died has no task id to poll. PiAPI may or may not
 *  have accepted it; after this window we stop hoping and refund the user. */
const SUBMIT_GRACE_MS = 10 * 60_000;
/** Seedance resolves in 30–120s. A row still non-terminal after this is dead
 *  upstream — close it and refund rather than leave credits hanging. */
export const MAX_AGE_MS = 2 * 60 * 60_000;

/** A hybrid's parent row while its footage renders, and while it is being
 *  handed to the motion worker. Not 'pending': nothing is upstream for it yet,
 *  so the no-task-id grace below must not fail it. lib/media/hybridJob.ts owns it. */
export const HYBRID_WAITING = 'footage';
export const HYBRID_SUBMITTING = 'hybrid_submitting';
/** Cinema is slower by design — a 30s render is ~50 minutes of GPU, and it
 *  queues behind at most two others. Two hours would reap live work. */
const CINEMA_MAX_AGE_MS = 6 * 60 * 60_000;

export async function finalizeVideoJob(job: VideoJob): Promise<FinalizeVideoResult> {
  // Already terminal — short-circuit so the client can stop polling.
  if (job.status === 'completed' && job.mediaAssetId) {
    const done = { status: 'completed' as const, asset: await loadAsset(job.mediaAssetId), rewrittenPrompt: job.rewrittenPrompt };
    // Claimed by the sweeper first: the warning is only in what finalize stored.
    const audioWarning = job.provider === 'motion-claude' ? await savedAudioWarning(job.id) : undefined;
    return audioWarning ? { ...done, audioWarning } : done;
  }
  if (job.status === 'failed') return { status: 'failed', error: job.error ?? 'unknown' };
  // Parked for a render slot (lib/agent/media.ts): uncharged and not upstream,
  // so the no-task-id grace below must not fail it. Its sweep owns it.
  if (job.status === 'queued' || job.status === 'submitting') return { status: 'pending', providerStatus: 'queued' };
  if (job.status === HYBRID_WAITING || job.status === HYBRID_SUBMITTING) return { status: 'pending', providerStatus: 'footage' };

  // Cinema runs on a different backend with a different poll, a different
  // failure vocabulary and an AUTHENTICATED artifact URL. Split here rather
  // than threading conditionals through the body below: everything downstream
  // of "we have bytes" is genuinely shared, everything upstream genuinely is
  // not.
  if (job.provider === 'cue-h3') return finalizeCinemaJob(job);
  if (job.provider === 'motion-hf') return finalizeMotionJob(job, motionConfigured, getMotionResult);
  if (job.provider === 'motion-claude') return finalizeMotionJob(job, motionAiConfigured, getMotionAiResult);

  const apiKey = process.env.PIAPI_API_KEY;
  if (!apiKey) return { status: 'pending', pollError: 'video_provider_not_configured' };
  // R2 is where the MP4 has to land. Without it we'd download the clip and
  // throw it away — and worse, claim the row 'completed' with no asset. Stay
  // pending instead: the provider URL lives for hours, so a fixed config
  // recovers the job. generate-video refuses new jobs while R2 is unset.
  if (isStubMode.r2()) return { status: 'pending', pollError: 'r2_not_configured' };

  const ageMs = Date.now() - job.createdAt.getTime();

  // No task id: the submit call never confirmed (ambiguous socket death). We
  // can't ask PiAPI about a task id we never received, so the row exists purely
  // so the charge isn't invisible. Refund once the grace window is up.
  if (!job.providerTaskId) {
    if (ageMs > SUBMIT_GRACE_MS) return failAndRefund(job, 'submit_unconfirmed');
    return { status: 'pending', providerStatus: 'submitting' };
  }

  let result;
  try {
    result = await getSeedanceTask({ taskId: job.providerTaskId, apiKey });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[finalize-video] piapi poll failed:', msg.slice(0, 400));
    // A poll that keeps erroring must still age out, or the job is immortal and
    // the customer's credits are held forever. Observed in production: the
    // provider purges old tasks, so an 11-day-old job answered "failed to find
    // task" on every sweep and never reached the MAX_AGE_MS check below — it
    // returned here first. A transient provider blip is covered because this
    // only fires once the job is older than the same give-up window.
    if (ageMs > MAX_AGE_MS) return failAndRefund(job, 'provider_stuck');
    return { status: 'pending', pollError: msg.slice(0, 200) };
  }

  if (result.status === 'pending' || result.status === 'processing' || result.status === 'staged') {
    if (ageMs > MAX_AGE_MS) return failAndRefund(job, 'provider_stuck');
    // Touch updatedAt — the sweeper picks oldest-updated first, so this
    // doubles as the backoff between sweeps.
    await db().update(videoJobs).set({ updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
    return { status: 'pending', providerStatus: result.status };
  }

  if (result.status === 'failed') return failAndRefund(job, `piapi_failed: ${result.error ?? 'unknown'}`);
  if (!result.videoUrl) return failAndRefund(job, 'completed_without_video_url');

  console.log('[finalize-video] storing', job.id, '→', result.videoUrl.slice(0, 80));

  let dl;
  try {
    dl = await downloadToBuffer(result.videoUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[finalize-video] download failed:', msg.slice(0, 300));
    return failAndRefund(job, `store_failed: ${msg.slice(0, 200)}`);
  }

  return storeAndClaim(job, dl.buffer, dl.contentType || 'video/mp4');
}

/**
 * Put the bytes in R2 and claim the row — the half both backends share.
 *
 * Upload BEFORE claiming: the upload can fail, and a claimed 'completed' row
 * with no asset is a zombie the client polls forever.
 *
 * The claim, the asset insert and the link are ONE transaction, and it is
 * MANDATORY that they stay one. As three separate commits the row was briefly
 * status='completed' with media_asset_id IS NULL, which GET /api/v1/videos/{id}
 * reports as a completion carrying no video_url; the image path shipped the same
 * ordering and a caller acted on that completion and discarded an asset they had
 * paid for. Committing together makes status and asset visible together. Do not
 * split this back apart.
 *
 * Only the caller whose conditional UPDATE matches inserts the asset, so two
 * overlapping finalizes still produce one asset — and the loser inserts nothing,
 * so it cannot leave an orphan row in the user's library.
 *
 * The upload stays outside the transaction: one is never held open across a
 * network hop (the deploy connects through a transaction-mode pooler).
 */
async function storeAndClaim(
  job: VideoJob,
  buffer: Buffer,
  contentType: string,
): Promise<FinalizeVideoResult> {
  const sizeBytes = buffer.length;
  const key = makeMediaKey(job.userId, `vid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`);
  try {
    await uploadBuffer({ key, body: buffer, contentType });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[finalize-video] upload failed:', msg.slice(0, 300));
    return failAndRefund(job, `store_failed: ${msg.slice(0, 200)}`);
  }
  return claimAsset(job, key, contentType, sizeBytes);
}

/** The claim half of storeAndClaim, for bytes already in R2 at `key`. */
async function claimAsset(job: VideoJob, key: string, contentType: string, sizeBytes: number | null): Promise<FinalizeVideoResult> {
  const asset = await db().transaction(async (tx) => {
    const claimed = await tx
      .update(videoJobs)
      .set({ status: 'completed', error: null, updatedAt: new Date() })
      .where(and(eq(videoJobs.id, job.id), ne(videoJobs.status, 'completed')))
      .returning({ id: videoJobs.id });
    if (claimed.length === 0) return null; // Lost the race — insert nothing.

    const [row] = await tx
      .insert(mediaAssets)
      .values({
        userId: job.userId,
        storageKey: key,
        publicUrl: publicUrlFor(key),
        mimeType: contentType,
        sizeBytes,
        durationS: String(job.durationSec),
        label: job.prompt.slice(0, 80),
      })
      .returning();

    await tx.update(videoJobs).set({ mediaAssetId: row.id, updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
    return row;
  });

  if (!asset) {
    // Lost the race. Our R2 object is a harmless orphan; report the winner's.
    const [fresh] = await db().select().from(videoJobs).where(eq(videoJobs.id, job.id)).limit(1);
    if (fresh?.mediaAssetId) {
      return { status: 'completed', asset: await loadAsset(fresh.mediaAssetId), rewrittenPrompt: job.rewrittenPrompt };
    }
    return { status: 'pending', providerStatus: 'finalizing' };
  }

  return { status: 'completed', asset, rewrittenPrompt: job.rewrittenPrompt };
}

/**
 * Reconcile one Cinema render. Same contract as the Seedance path above —
 * poll, store, or fail and refund — and the same conditional-claim transaction,
 * which is why the storage half is shared rather than copied.
 *
 * The one real difference: the finished file sits behind our bearer token, not
 * a public CDN link, so the download happens here and the vendor's copy is
 * deleted afterwards. Their storage is not our library.
 */
async function finalizeCinemaJob(job: VideoJob): Promise<FinalizeVideoResult> {
  if (isStubMode.cue()) return { status: 'pending', pollError: 'video_provider_not_configured' };
  if (isStubMode.r2()) return { status: 'pending', pollError: 'r2_not_configured' };

  const ageMs = Date.now() - job.createdAt.getTime();

  if (!job.providerTaskId) {
    if (ageMs > SUBMIT_GRACE_MS) return failAndRefund(job, 'submit_unconfirmed');
    return { status: 'pending', providerStatus: 'submitting' };
  }

  let render;
  try {
    render = await getCueRender(job.providerTaskId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A 404 is terminal, not transient: the render is gone and no amount of
    // polling brings it back, so hold the customer's credits no longer.
    if (e instanceof CueError && e.status === 404) return failAndRefund(job, 'cinema_failed: render not found');
    console.error('[finalize-video] cinema poll failed:', msg.slice(0, 400));
    if (ageMs > CINEMA_MAX_AGE_MS) return failAndRefund(job, 'provider_stuck');
    return { status: 'pending', pollError: msg.slice(0, 200) };
  }

  if (render.status === 'queued' || render.status === 'running') {
    if (ageMs > CINEMA_MAX_AGE_MS) return failAndRefund(job, 'provider_stuck');
    await db().update(videoJobs).set({ updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
    return { status: 'pending', providerStatus: render.status };
  }

  if (render.status === 'failed') {
    return failAndRefund(job, `cinema_failed: ${render.error ?? 'unknown'}`);
  }

  let dl;
  try {
    dl = await downloadCueRender(job.providerTaskId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[finalize-video] cinema download failed:', msg.slice(0, 300));
    // 409 means "not ready" — the vendor's own guidance is to poll the render,
    // not the file, so this is a pending state and not a failure.
    if (e instanceof CueError && e.status === 409) return { status: 'pending', providerStatus: 'finalizing' };
    if (ageMs > CINEMA_MAX_AGE_MS) return failAndRefund(job, `store_failed: ${msg.slice(0, 160)}`);
    return { status: 'pending', pollError: msg.slice(0, 200) };
  }

  const result = await storeAndClaim(job, dl.buffer, dl.contentType || 'video/mp4');
  // Only once OUR copy is committed. Deleting before the claim would destroy
  // the only copy if the transaction then lost its race and returned pending.
  if (result.status === 'completed') void deleteCueRender(job.providerTaskId);
  return result;
}

/**
 * Reconcile one motion-graphics render — template engine or AI-designed
 * worker, which share a result shape. The engine uploads straight to the
 * R2 key we chose at submit (inside the user's prefix) and echoes it back, so
 * there are no bytes to move — only the claim.
 *
 * MAX_AGE_MS (2h) is the give-up window for both. AI-designed jobs take 6–12
 * min (22 min worker cap) and the worker runs 2 at a time, so a queue of them
 * needs well over one job's time; 2h covers that without holding credits for long.
 * Long AI-designed jobs (up to 3 min of video, ~86 min worker cap) get twice their
 * extra worker time on top, so one queued behind two others isn't refunded mid-render.
 */
async function finalizeMotionJob(
  job: VideoJob,
  configured: () => boolean,
  getResult: (callId: string) => Promise<MotionAiResult>,
): Promise<FinalizeVideoResult> {
  if (!configured()) return { status: 'pending', pollError: 'video_provider_not_configured' };
  const ageMs = Date.now() - job.createdAt.getTime();
  const maxAgeMs = MAX_AGE_MS + 2 * motionAiExtraMin(job.durationSec) * 60_000;

  if (!job.providerTaskId) {
    if (ageMs > SUBMIT_GRACE_MS) return failAndRefund(job, 'submit_unconfirmed');
    return { status: 'pending', providerStatus: 'submitting' };
  }

  let r;
  try {
    r = await getResult(job.providerTaskId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[finalize-video] motion poll failed:', msg.slice(0, 400));
    if (ageMs > maxAgeMs) return failAndRefund(job, 'provider_stuck');
    return { status: 'pending', pollError: msg.slice(0, 200) };
  }

  if (r.status === 'pending') {
    if (ageMs > maxAgeMs) return failAndRefund(job, 'provider_stuck');
    await db().update(videoJobs).set({ updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
    return { status: 'pending', providerStatus: 'processing' };
  }
  if (r.status === 'failed') return failAndRefund(job, `motion_failed: ${r.error ?? 'unknown'}`);
  // Only a key inside this user's prefix — never let a result point the asset elsewhere.
  if (!r.videoKey?.startsWith(`users/${job.userId}/`)) return failAndRefund(job, 'store_failed: bad_motion_key');
  let claimed = await claimAsset(job, r.videoKey, 'video/mp4', r.sizeBytes ?? null);
  // The worker's poster is the thumbnail. Idempotent, so the race loser re-writing is fine.
  if (claimed.status === 'completed' && claimed.asset) {
    const posterUrl = await savePoster(job.userId, claimed.asset.id, r.posterKey);
    if (posterUrl) claimed = { ...claimed, asset: { ...claimed.asset, posterUrl } };
  }
  // AI-designed renders (originals and edits) keep their segments for the edit
  // timeline. Best-effort and idempotent, so the race loser re-writing is fine.
  if (claimed.status !== 'completed' || job.provider !== 'motion-claude') return claimed;
  await saveMotionResult(job, r);
  const audioWarning = cleanAudio(r.audio)?.warning;
  return audioWarning ? { ...claimed, audioWarning } : claimed;
}

async function loadAsset(id: string): Promise<(MediaAsset & { posterUrl?: string }) | undefined> {
  const [asset] = await db().select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
  const posterUrl = asset && (await posterUrls(asset.userId, [asset.id])).get(asset.id);
  return posterUrl ? { ...asset, posterUrl } : asset;
}

/**
 * Mark the job failed and return its credits. The UPDATE is conditional on the
 * row not already being terminal, and the refund only fires if we claimed it —
 * so two concurrent finalizes can't double-refund even before refund()'s own
 * idempotency check.
 */
async function failAndRefund(job: VideoJob, error: string): Promise<FinalizeVideoResult> {
  const claimed = await db()
    .update(videoJobs)
    .set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(videoJobs.id, job.id), notInArray(videoJobs.status, ['completed', 'failed'])))
    .returning({ id: videoJobs.id });

  if (claimed.length > 0 && job.creditLedgerId) {
    try {
      // videoJobId so an API customer can reconcile a refund row against the
      // job that caused it — the charge carries it, the refund used not to.
      await refund({
        userId: job.userId,
        ledgerId: job.creditLedgerId,
        reason: error.slice(0, 120),
        meta: { videoJobId: job.id },
      });
    } catch (e) {
      console.warn('[finalize-video] refund failed:', e instanceof Error ? e.message : e);
    }
  }
  return { status: 'failed', error };
}
