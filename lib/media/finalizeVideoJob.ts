import { and, eq, ne, notInArray } from 'drizzle-orm';
import { db } from '../db';
import { videoJobs, mediaAssets } from '../db/schema';
import { getSeedanceTask } from '../ai/piapi';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../storage/r2';
import { downloadToBuffer } from './finalize';
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
  | { status: 'completed'; asset?: MediaAsset; rewrittenPrompt?: string | null }
  | { status: 'failed'; error: string };

/** A submit whose socket died has no task id to poll. PiAPI may or may not
 *  have accepted it; after this window we stop hoping and refund the user. */
const SUBMIT_GRACE_MS = 10 * 60_000;
/** Seedance resolves in 30–120s. A row still non-terminal after this is dead
 *  upstream — close it and refund rather than leave credits hanging. */
const MAX_AGE_MS = 2 * 60 * 60_000;

export async function finalizeVideoJob(job: VideoJob): Promise<FinalizeVideoResult> {
  // Already terminal — short-circuit so the client can stop polling.
  if (job.status === 'completed' && job.mediaAssetId) {
    return { status: 'completed', asset: await loadAsset(job.mediaAssetId), rewrittenPrompt: job.rewrittenPrompt };
  }
  if (job.status === 'failed') return { status: 'failed', error: job.error ?? 'unknown' };

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

  // Download AND upload before claiming the row: both hops can fail, and a
  // claimed 'completed' row with no asset is a zombie the client polls forever.
  let key: string;
  let contentType = 'video/mp4';
  let sizeBytes = 0;
  try {
    const dl = await downloadToBuffer(result.videoUrl);
    contentType = dl.contentType || 'video/mp4';
    sizeBytes = dl.buffer.length;
    key = makeMediaKey(job.userId, `vid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`);
    await uploadBuffer({ key, body: dl.buffer, contentType });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[finalize-video] store failed:', msg.slice(0, 300));
    return failAndRefund(job, `store_failed: ${msg.slice(0, 200)}`);
  }

  // Claim, insert the asset and link it — in ONE transaction, and MANDATORY that
  // it stays one. As three separate commits the row was briefly
  // status='completed' with media_asset_id IS NULL, which GET /api/v1/videos/{id}
  // reports as a completion carrying no video_url; the image path shipped the
  // same ordering and a caller acted on that completion and discarded an asset
  // they had paid for. Committing together makes status and asset visible
  // together. Do not split this back apart.
  //
  // Only the caller whose conditional UPDATE matches inserts the asset, so two
  // overlapping finalizes still produce one asset — and the loser inserts
  // nothing, so it cannot leave an orphan row in the user's library.
  //
  // The download and upload stay above: a transaction is never held open across
  // a network hop (the deploy connects through a transaction-mode pooler).
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

async function loadAsset(id: string): Promise<MediaAsset | undefined> {
  const [asset] = await db().select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
  return asset;
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
