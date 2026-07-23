import { NextRequest } from 'next/server';
import { withUser, jsonOk, jsonError } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { apifyToken } from '../../../../lib/scrapers/apify-client';
import { refreshCompetitors } from '../../../../lib/intel/refresh-competitors';
import { checkQuota, recordUsage } from '../../../../lib/usage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.database()) return jsonError('database not configured', 503);
    if (!apifyToken()) return jsonError('APIFY_TOKEN not configured — set it to pull live competitor data', 400);
    await checkQuota(user.id, 'analysis');
    const result = await refreshCompetitors(user.id);
    if (result.scraped > 0) await recordUsage(user.id, 'analysis', 1, { feature: 'competitor_refresh' });
    return jsonOk(result);
  }, req);
}
