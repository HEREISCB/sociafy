import { checkCronAuth, jsonError, jsonOk } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { db } from '../../../../lib/db';
import { trendSettings, type TrendPlatform } from '../../../../lib/db/schema';
import { refreshTrends } from '../../../../lib/taccv/refresh';
import { buildCrossPlatformRadar, logHighAlerts } from '../../../../lib/intel/cross-platform-radar';

export const dynamic = 'force-dynamic';

const PLATFORMS: TrendPlatform[] = ['instagram', 'tiktok', 'youtube'];

async function run(request: Request) {
  if (!checkCronAuth(request)) return jsonError('unauthorized', 401);
  if (isStubMode.database()) return jsonOk({ skipped: true, reason: 'no db' });

  const users = await db().select({ userId: trendSettings.userId }).from(trendSettings).limit(50);
  const results = [];
  for (const u of users) {
    const perPlatform: Record<string, unknown> = {};
    for (const platform of PLATFORMS) perPlatform[platform] = await refreshTrends(u.userId, false, platform);
    const radar = await buildCrossPlatformRadar(u.userId);
    const alertsLogged = await logHighAlerts(u.userId, radar);
    results.push({ userId: u.userId, ...perPlatform, alertsLogged });
  }
  return jsonOk({ refreshed: results.length, results });
}

export async function GET(request: Request) { return run(request); }
export async function POST(request: Request) { return run(request); }
