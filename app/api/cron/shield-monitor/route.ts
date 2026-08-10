import { NextRequest, NextResponse } from 'next/server';
import { runShieldMonitor } from '../../../../lib/cron/shieldMonitor';
import { checkCronAuth } from '../../../../lib/api';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * HTTP entry point for scheduled Reputation Shield monitoring. The scan fan-out
 * lives in lib/cron/shieldMonitor.ts so the on-box cron runner
 * (`scripts/cron-run.mjs shield-monitor`) can call it without HTTP.
 */
export async function GET(req: NextRequest) {
  // checkCronAuth, not env.cronSecret: env.cronSecret falls back to the value
  // published in .env.example, so an unset CRON_SECRET made this scan (real
  // TwitterAPI.io spend + Slack alerts to every user) publicly triggerable.
  // checkCronAuth refuses to run without a real secret and compares in
  // constant time.
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  return NextResponse.json(await runShieldMonitor());
}
