import { NextRequest, NextResponse } from 'next/server';
import { checkCronAuth } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { runPublish } from '../../../../lib/cron/publish';

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
  if (isStubMode.database()) return NextResponse.json({ skipped: 'no_database' });
  const out = await runPublish();
  return NextResponse.json(out);
}
