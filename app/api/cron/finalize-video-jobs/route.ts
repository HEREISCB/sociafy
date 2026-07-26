import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, lt } from 'drizzle-orm';
import { checkCronAuth } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { db } from '../../../../lib/db';
import { videoJobs } from '../../../../lib/db/schema';
import { finalizeVideoJob } from '../../../../lib/media/finalizeVideoJob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Each job may download + re-upload a ~100MB MP4. 10 of those needs room.
export const maxDuration = 300;

/** Per-run cap. Overflow is not requeued explicitly — rows stay 'pending' and
 *  we order oldest-updated first, so the next tick picks up where we left off. */
const BATCH_LIMIT = 10;
/** Don't fight the browser poller for a job it's actively finalizing. */
const MIN_IDLE_MS = 60_000;

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

/**
 * Reaper for video_jobs. Without it, completion depends on the user keeping the
 * tab open: PiAPI has already charged us, a failed job would never be refunded,
 * and a finished clip's provider URL expires before it reaches R2.
 *
 * Runs the same lib/media/finalizeVideoJob path as the poller, which claims
 * rows conditionally — so overlapping cron ticks (or a tick racing a live poll)
 * can't double-store or double-refund.
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

  return NextResponse.json({ swept: stale.length, moreLikely: stale.length === BATCH_LIMIT, results });
}
