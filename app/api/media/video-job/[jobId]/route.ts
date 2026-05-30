import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../../lib/api';
import { db } from '../../../../../lib/db';
import { videoJobs, mediaAssets } from '../../../../../lib/db/schema';
import { getSeedanceTask } from '../../../../../lib/ai/piapi';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../../../lib/storage/r2';
import { downloadToBuffer } from '../../../../../lib/media/finalize';
import { refund } from '../../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/media/video-job/[jobId]
 *
 * Client polls this every few seconds while the Seedance task is running.
 * If the upstream task is still cooking → returns `{ pending: true }`.
 * When the task lands → downloads the finished MP4, uploads to R2, inserts
 * a media_assets row, marks the job completed, and returns the asset row.
 *
 * Idempotent: if status is already 'completed', we return the existing
 * media asset without re-downloading. Concurrent polls can't double-finalize
 * because we re-check status under the row update.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withUser(async (user) => {
    const { jobId } = await ctx.params;
    if (!jobId) return jsonError('missing_job_id', 400);
    if (!process.env.PIAPI_API_KEY) return jsonError('video_provider_not_configured', 503);

    const [job] = await db()
      .select()
      .from(videoJobs)
      .where(and(eq(videoJobs.id, jobId), eq(videoJobs.userId, user.id)))
      .limit(1);
    if (!job) return jsonError('job_not_found', 404);

    // Already finalized — short-circuit so the client can stop polling.
    if (job.status === 'completed' && job.mediaAssetId) {
      const [asset] = await db().select().from(mediaAssets).where(eq(mediaAssets.id, job.mediaAssetId)).limit(1);
      return { status: 'completed' as const, asset, rewrittenPrompt: job.rewrittenPrompt };
    }
    if (job.status === 'failed') {
      return { status: 'failed' as const, error: job.error ?? 'unknown' };
    }

    // Poll PiAPI.
    let result;
    try {
      result = await getSeedanceTask({ taskId: job.providerTaskId, apiKey: process.env.PIAPI_API_KEY });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[video-job] piapi poll failed:', msg.slice(0, 400));
      return { status: 'pending' as const, pollError: msg.slice(0, 200) };
    }

    if (result.status === 'pending' || result.status === 'processing' || result.status === 'staged') {
      // Touch updatedAt so we can spot stuck jobs in the DB later.
      await db().update(videoJobs).set({ updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
      return { status: 'pending' as const, providerStatus: result.status };
    }

    if (result.status === 'failed') {
      await db()
        .update(videoJobs)
        .set({ status: 'failed', error: result.error ?? 'piapi_failed', updatedAt: new Date() })
        .where(eq(videoJobs.id, job.id));
      // Refund credits for the failed job.
      if (job.creditLedgerId) {
        try {
          await refund({ userId: user.id, ledgerId: job.creditLedgerId, reason: `piapi_failed: ${result.error ?? 'unknown'}` });
        } catch (e) {
          console.warn('[video-job] refund failed:', e instanceof Error ? e.message : e);
        }
      }
      return { status: 'failed' as const, error: result.error ?? 'piapi_failed' };
    }

    // Completed. Pull the MP4 down, push it to R2, write the asset row.
    if (!result.videoUrl) {
      await db()
        .update(videoJobs)
        .set({ status: 'failed', error: 'completed_without_video_url', updatedAt: new Date() })
        .where(eq(videoJobs.id, job.id));
      if (job.creditLedgerId) {
        try { await refund({ userId: user.id, ledgerId: job.creditLedgerId, reason: 'completed_without_video_url' }); } catch {}
      }
      return { status: 'failed' as const, error: 'completed_without_video_url' };
    }

    console.log('[video-job] finalizing', job.id, '→', result.videoUrl.slice(0, 80));

    let videoBuffer: Buffer;
    let contentType = 'video/mp4';
    try {
      const dl = await downloadToBuffer(result.videoUrl);
      videoBuffer = dl.buffer;
      contentType = dl.contentType || 'video/mp4';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[video-job] download failed:', msg.slice(0, 300));
      await db()
        .update(videoJobs)
        .set({ status: 'failed', error: `download_failed: ${msg.slice(0, 200)}`, updatedAt: new Date() })
        .where(eq(videoJobs.id, job.id));
      if (job.creditLedgerId) {
        try { await refund({ userId: user.id, ledgerId: job.creditLedgerId, reason: `download_failed: ${msg.slice(0, 80)}` }); } catch {}
      }
      return { status: 'failed' as const, error: 'download_failed' };
    }

    const key = makeMediaKey(user.id, `vid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`);
    await uploadBuffer({ key, body: videoBuffer, contentType });
    const publicUrl = publicUrlFor(key);

    const [asset] = await db()
      .insert(mediaAssets)
      .values({
        userId: user.id,
        storageKey: key,
        publicUrl,
        mimeType: contentType,
        sizeBytes: videoBuffer.length,
        durationS: String(job.durationSec),
        label: job.prompt.slice(0, 80),
      })
      .returning();

    await db()
      .update(videoJobs)
      .set({ status: 'completed', mediaAssetId: asset.id, updatedAt: new Date() })
      .where(eq(videoJobs.id, job.id));

    return { status: 'completed' as const, asset, rewrittenPrompt: job.rewrittenPrompt };
  }, req);
}
