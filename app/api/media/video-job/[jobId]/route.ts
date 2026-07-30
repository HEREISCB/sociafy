import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../../lib/api';
import { db } from '../../../../../lib/db';
import { videoJobs } from '../../../../../lib/db/schema';
import { isStubMode } from '../../../../../lib/env';
import { finalizeVideoJob } from '../../../../../lib/media/finalizeVideoJob';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/media/video-job/[jobId]
 *
 * Client polls this every few seconds while the Seedance task is running.
 * All of the reconcile logic lives in lib/media/finalizeVideoJob so the cron
 * sweeper (/api/cron/finalize-video-jobs) runs the exact same path when the
 * tab is closed. Concurrent polls are safe: finalizeVideoJob claims the row
 * with a conditional UPDATE, so only one asset row and one refund happen.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withUser(async (user) => {
    const { jobId } = await ctx.params;
    if (!jobId) return jsonError('missing_job_id', 400);
    if (!process.env.PIAPI_API_KEY) return jsonError('video_provider_not_configured', 503);
    if (isStubMode.r2()) {
      return jsonError('r2_not_configured', 503, {
        hint: 'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, NEXT_PUBLIC_R2_PUBLIC_URL_BASE.',
      });
    }

    const [job] = await db()
      .select()
      .from(videoJobs)
      .where(and(eq(videoJobs.id, jobId), eq(videoJobs.userId, user.id)))
      .limit(1);
    if (!job) return jsonError('job_not_found', 404);

    const result = await finalizeVideoJob(job);
    // Same invariant the /api/v1 readers enforce: never announce a completion we
    // cannot hand over. Completion is atomic now, so this only fires if the asset
    // row was deleted out from under the job — in which case "still working" is
    // honest and the UI keeps polling, rather than rendering a finished job with
    // no video in it.
    if (result.status === 'completed' && !result.asset) {
      console.warn('[video-job] completed with no asset, reporting pending:', job.id);
      return { status: 'pending' as const };
    }
    return result;
  }, req);
}
