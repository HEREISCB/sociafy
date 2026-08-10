import { NextRequest, NextResponse } from 'next/server';
import { checkCronAuth } from '../../../../lib/api';
import { runFinalizeJobs } from '../../../../lib/cron/finalizeJobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Each job may download + re-upload a ~100MB MP4. 10 of those needs room.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

/**
 * HTTP entry point for the stale-job reaper. The sweep itself lives in
 * lib/cron/finalizeJobs.ts because the on-box cron runner
 * (`scripts/cron-run.mjs finalize-video-jobs`) calls it directly, without HTTP
 * and without CRON_SECRET. This route is auth + JSON, nothing else.
 */
async function run(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await runFinalizeJobs());
}
