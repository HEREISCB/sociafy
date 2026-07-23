import { eq } from 'drizzle-orm';
import { checkCronAuth, jsonError, jsonOk } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { apifyToken } from '../../../../lib/scrapers/apify-client';
import { db } from '../../../../lib/db';
import { competitors } from '../../../../lib/db/schema';
import { refreshCompetitors } from '../../../../lib/intel/refresh-competitors';

export const dynamic = 'force-dynamic';

// Daily accumulation of competitor posts + one metrics row/day, so the forecast
// history builds up without manual clicks. refreshCompetitors skips handles
// already scraped today, so re-runs are free.
async function run(request: Request) {
  if (!checkCronAuth(request)) return jsonError('unauthorized', 401);
  if (isStubMode.database()) return jsonOk({ skipped: true, reason: 'no db' });
  if (!apifyToken()) return jsonOk({ skipped: true, reason: 'no apify token' });

  const users = await db()
    .selectDistinct({ userId: competitors.userId })
    .from(competitors)
    .where(eq(competitors.isActive, true));

  const results = [];
  for (const u of users) {
    results.push({ userId: u.userId, ...(await refreshCompetitors(u.userId)) });
  }
  return jsonOk({ refreshed: results.length, results });
}

export async function GET(request: Request) { return run(request); }
export async function POST(request: Request) { return run(request); }
