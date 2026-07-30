import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, lt } from 'drizzle-orm';
import { checkCronAuth } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { db } from '../../../../lib/db';
import { genJobs, videoJobs } from '../../../../lib/db/schema';
import { finalizeVideoJob } from '../../../../lib/media/finalizeVideoJob';
import { failImageJob, IMAGE_JOB_KIND } from '../../v1/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Each job may download + re-upload a ~100MB MP4. 10 of those needs room.
export const maxDuration = 300;

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

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

/**
 * Reaper for video_jobs AND for async image gen_jobs. Both exist for the same
 * reason: a charge that nothing will ever close out.
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
async function run(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (isStubMode.database()) return NextResponse.json({ skipped: 'no_database' });

  const stale = await db()
    .select()
    .from(videoJobs)
    .where(and(eq(videoJobs.status, 'pending'), lt(videoJobs.updatedAt, new Date(Date.now() - MIN_IDLE_MS))))
    .orderBy(asc(videoJobs.updatedAt))
    .limit(BATCH_LIMIT);

  const results: { id: string; status: string; error?: string }[] = [];
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

  return NextResponse.json({
    swept: stale.length,
    sweptImages: staleImages.length,
    moreLikely: stale.length === BATCH_LIMIT || staleImages.length === BATCH_LIMIT,
    results,
  });
}
