import { NextRequest, NextResponse } from 'next/server';
import { checkCronAuth } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { runTrends } from '../../../../lib/cron/trends';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (isStubMode.database()) return NextResponse.json({ skipped: 'no_database' });
  const users = await runTrends();
  return NextResponse.json({ users });
}
