import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { checkCronAuth } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { connectedAccounts } from '../../../../lib/db/schema';
import { ensureFreshToken } from '../../../../lib/platforms/token';
import { isStubMode } from '../../../../lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HORIZON_HOURS = 24;

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

  const horizon = new Date(Date.now() + HORIZON_HOURS * 60 * 60 * 1000);
  const candidates = await db()
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.isStub, false),
        isNotNull(connectedAccounts.tokenExpiresAt),
        isNotNull(connectedAccounts.refreshToken),
        lte(connectedAccounts.tokenExpiresAt, horizon),
      ),
    );

  const results: Array<{ id: string; platform: string; refreshed: boolean }> = [];
  for (const acct of candidates) {
    const beforeExp = acct.tokenExpiresAt?.getTime() ?? 0;
    const after = await ensureFreshToken(acct);
    const afterExp = after.tokenExpiresAt?.getTime() ?? 0;
    results.push({
      id: acct.id,
      platform: acct.platform,
      refreshed: afterExp > beforeExp,
    });
  }

  return NextResponse.json({ scanned: candidates.length, results });
}
