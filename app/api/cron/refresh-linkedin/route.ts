import { eq } from 'drizzle-orm';
import { checkCronAuth, jsonError, jsonOk } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { apifyToken } from '../../../../lib/scrapers/apify-client';
import { db } from '../../../../lib/db';
import { linkedinCompanies } from '../../../../lib/db/schema';
import { refreshLinkedIn } from '../../../../lib/intel/refresh-linkedin';

export const dynamic = 'force-dynamic';

// Daily snapshot of each tracked LinkedIn company so follower/headcount growth
// builds up without manual clicks. refreshLinkedIn skips companies already
// scraped today, so re-runs are free.
async function run(request: Request) {
  if (!checkCronAuth(request)) return jsonError('unauthorized', 401);
  if (isStubMode.database()) return jsonOk({ skipped: true, reason: 'no db' });
  if (!apifyToken()) return jsonOk({ skipped: true, reason: 'no apify token' });

  const users = await db()
    .selectDistinct({ userId: linkedinCompanies.userId })
    .from(linkedinCompanies)
    .where(eq(linkedinCompanies.isActive, true));

  const results = [];
  for (const u of users) {
    results.push({ userId: u.userId, ...(await refreshLinkedIn(u.userId)) });
  }
  return jsonOk({ refreshed: results.length, results });
}

export async function GET(request: Request) { return run(request); }
export async function POST(request: Request) { return run(request); }
