import { NextRequest, NextResponse } from 'next/server';
import { checkCronAuth } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { runRefreshTokens } from '../../../../lib/cron/refreshTokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (isStubMode.database()) {
    return NextResponse.json({ skipped: 'no_database' });
  }
  const out = await runRefreshTokens();
  return NextResponse.json(out);
}
