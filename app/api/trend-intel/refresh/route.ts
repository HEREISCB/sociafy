import { NextRequest } from 'next/server';
import { withUser, jsonOk, jsonError } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { refreshTrends } from '../../../../lib/taccv/refresh';
import { checkQuota, recordUsage } from '../../../../lib/usage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.database()) return jsonError('database not configured', 503);
    const force = req.nextUrl.searchParams.get('force') === '1';
    await checkQuota(user.id, 'analysis');
    const result = await refreshTrends(user.id, force);
    if (!result.skipped) await recordUsage(user.id, 'analysis', 1, { feature: 'trend_refresh' });
    return jsonOk(result);
  }, req);
}
