import { and, asc, eq, lt } from 'drizzle-orm';
import { db } from '../db';
import { genJobs, videoJobs } from '../db/schema';
import { isStubMode } from '../env';
import { finalizeVideoJob } from '../media/finalizeVideoJob';
// failImageJob is colocated with the /v1/images route that writes these rows and
// is the only claim-then-refund path for them. Importing app/ from lib/ is
// unusual here, but a second copy of a refund is how you get a double refund.
import { failImageJob, IMAGE_JOB_KIND } from '../../app/api/v1/shared';

/** Per-run cap, per kind. Overflow is not requeued explicitly — rows stay
 *  'pending' and we order oldest first, so the next tick picks up where we left
 *  off. */
const BATCH_LIMIT = 10;
/** Don't fight the browser poller for a job it's actively finalizing. */
const MIN_IDLE_MS = 60_000;
/**
 * How long an async image job may stay 'pending' before we give up on it.
 *
 * An image is generated in the POST's own `after()` callback, bounded by that
 * route's maxDuration of 300s, and ~83s is the measured worst case — so a row
 * older than this has lost its process (an instance recycled, a deploy landing
 * mid-flight) and nothing else will ever finish it. Comfortably longer than the
 * route can run, so a live generation is never swept out from under itself.
 */
const IMAGE_GRACE_MS = 10 * 60_000;

export type FinalizeJobsResult = {
  swept: number;
  sweptImages: number;
  moreLikely: boolean;
  results: { id: string; status: string; error?: string }[];
  skipped?: 'no_database';
};

/**
 * Reaper for video_jobs AND for async image gen_jobs. Both exist for the same
 * reason: a charge that nothing will ever close out.
 *
 * Two entry points call this and neither owns it: `/api/cron/finalize-video-jobs`
 * (HTTP, for hosts driven by GitHub Actions) and `scripts/cron-run.mjs
 * finalize-video-jobs` (on-box cron, no HTTP, no CRON_SECRET). Keep the logic
 * here — a copy in the route is a copy that drifts, and this one moves money.
 *
 * Videos: without this, completion depends on the user keeping the tab open —
 * PiAPI has already charged us, a failed job would never be refunded, and a
 * finished clip's provider URL expires before it reaches R2. Runs the same
 * lib/media/finalizeVideoJob path as the poller, which claims rows conditionally,
 * so overlapping cron ticks (or a tick racing a live poll) can't double-store or
 * double-refund.
 *
 * Images (`POST /api/v1/images` with `async: true`): generation happens in that
 * request's `after()` callback, so a process lost mid-flight strands the row
 * 'pending' with the credits held. Those cannot be resumed — the reference-image
 * bytes are gone with the process — so after IMAGE_GRACE_MS they are failed and
 * refunded. failImageJob claims conditionally too, so it cannot double-refund a
 * row the in-request finaliser is settling at the same moment.
 */
export async function runFinalizeJobs(): Promise<FinalizeJobsResult> {
  if (isStubMode.database()) {
    return { swept: 0, sweptImages: 0, moreLikely: false, results: [], skipped: 'no_database' };
  }

  const stale = await db()
    .select()
    .from(videoJobs)
    .where(and(eq(videoJobs.status, 'pending'), lt(videoJobs.updatedAt, new Date(Date.now() - MIN_IDLE_MS))))
    .orderBy(asc(videoJobs.updatedAt))
    .limit(BATCH_LIMIT);

  const results: FinalizeJobsResult['results'] = [];
  for (const job of stale) {
    try {
      const out = await finalizeVideoJob(job);
      results.push({ id: job.id, status: out.status });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[cron/finalize-video-jobs]', job.id, msg.slice(0, 300));
      results.push({ id: job.id, status: 'error', error: msg.slice(0, 200) });
    }
  }

  // Oldest-created first, not oldest-updated: nothing touches an image row while
  // it generates, so createdAt is the only honest clock for its age.
  const staleImages = await db()
    .select()
    .from(genJobs)
    .where(
      and(
        eq(genJobs.kind, IMAGE_JOB_KIND),
        eq(genJobs.status, 'pending'),
        lt(genJobs.createdAt, new Date(Date.now() - IMAGE_GRACE_MS)),
      ),
    )
    .orderBy(asc(genJobs.createdAt))
    .limit(BATCH_LIMIT);

  for (const job of staleImages) {
    try {
      await failImageJob(job, 'generation_timeout');
      results.push({ id: job.id, status: 'failed' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[cron/finalize-video-jobs] image', job.id, msg.slice(0, 300));
      results.push({ id: job.id, status: 'error', error: msg.slice(0, 200) });
    }
  }

  return {
    swept: stale.length,
    sweptImages: staleImages.length,
    moreLikely: stale.length === BATCH_LIMIT || staleImages.length === BATCH_LIMIT,
    results,
  };
}
