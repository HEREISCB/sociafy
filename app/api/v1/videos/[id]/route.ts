import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withApiKey } from '../../../../../lib/api-key';
import { db } from '../../../../../lib/db';
import { videoJobs } from '../../../../../lib/db/schema';
import { finalizeVideoJob } from '../../../../../lib/media/finalizeVideoJob';
import { modelForBackend } from '../../../../../lib/ai/models';
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

    const [job] = await db()
      .select()
      .from(videoJobs)
      .where(and(eq(videoJobs.id, id), eq(videoJobs.userId, auth.userId)))
      .limit(1);
    if (!job) return apiError('not_found', 404, 'No such generation.');

    // Checked against the job's OWN backend, after the lookup: polling a Cinema
    // render must not 503 because the Motion key is missing, and vice versa.
    const pre = job.provider === 'cue-h3'
      ? providerPreflight({ r2: true, cue: true })
      : providerPreflight({ r2: true, piapi: true });
    if (pre) return pre;

    const result = await finalizeVideoJob(job);

    // Never announce a completion we cannot deliver: a caller who believes a
    // `completed` carrying a null url discards an asset they already paid for.
    // If the asset does not resolve the work is not deliverable yet, so report it
    // as pending and let the poll loop continue. finalizeVideoJob's transaction
    // should make this unreachable; the warn is how we learn if it isn't.
    const videoUrl = result.status === 'completed' ? (result.asset?.publicUrl ?? null) : null;
    const status = result.status === 'completed' && !videoUrl ? 'pending' : result.status;
    if (status !== result.status) {
      console.warn('[v1/videos] job', job.id, 'is completed with no resolvable asset; reporting pending');
    }

    return Response.json({
      id: job.id,
      // Our model id, mapped from the internal backend column — which is
      // operational and never leaves the process.
      model: modelForBackend(job.provider),
      status,
      video_url: videoUrl,
      // What the ledger debited. A failed job is refunded automatically, so
      // this is history, not your current balance — see GET /api/v1/me.
      credits_charged: job.creditsCharged ?? 0,
      error: result.status === 'failed' ? publicVideoError(result.error) : null,
    });
  });
}
