import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withApiKey } from '../../../../../lib/api-key';
import { db } from '../../../../../lib/db';
import { videoJobs } from '../../../../../lib/db/schema';
import { finalizeVideoJob } from '../../../../../lib/media/finalizeVideoJob';
import { apiError, providerPreflight, publicVideoError, UUID_RX } from '../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Matches the first-party poller. A finalize that runs long just times out and
// the next poll retries — finalizeVideoJob claims the row conditionally, so
// that's safe. The cron sweeper (maxDuration 300) is the backstop for the
// largest files.
export const maxDuration = 60;

/**
 * GET /api/v1/videos/{id}
 *
 * Polling also DRIVES completion: the reconcile lives in
 * lib/media/finalizeVideoJob, the one shared path the browser poller, the cron
 * sweeper and the PiAPI webhook all run. Concurrent polls are safe (conditional
 * claim), and a caller who stops polling still gets finalized by cron.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKey(req, async (auth) => {
    const { id } = await ctx.params;
    // Tenant scoping is the WHERE clause, not a post-hoc check: another
    // tenant's id is indistinguishable from a nonexistent one.
    // Strict uuid: `[0-9a-f-]{36}` let through 36-char strings Postgres cannot
    // cast, and that cast threw inside the query, so a typo rendered a 500.
    if (!UUID_RX.test(id)) return apiError('not_found', 404, 'No such generation.');

    const pre = providerPreflight({ r2: true, piapi: true });
    if (pre) return pre;

    const [job] = await db()
      .select()
      .from(videoJobs)
      .where(and(eq(videoJobs.id, id), eq(videoJobs.userId, auth.userId)))
      .limit(1);
    if (!job) return apiError('not_found', 404, 'No such generation.');

    const result = await finalizeVideoJob(job);

    return Response.json({
      id: job.id,
      status: result.status,
      video_url: result.status === 'completed' ? (result.asset?.publicUrl ?? null) : null,
      // What the ledger debited. A failed job is refunded automatically, so
      // this is history, not your current balance — see GET /api/v1/me.
      credits_charged: job.creditsCharged ?? 0,
      error: result.status === 'failed' ? publicVideoError(result.error) : null,
    });
  });
}
