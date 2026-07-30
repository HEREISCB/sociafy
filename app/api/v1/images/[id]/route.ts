import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withApiKey } from '../../../../../lib/api-key';
import { db } from '../../../../../lib/db';
import { genJobs, mediaAssets } from '../../../../../lib/db/schema';
import { apiError, IMAGE_JOB_KIND, providerPreflight, UUID_RX } from '../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/v1/images/{id} — poll an `async: true` generation.
 *
 * A pure read, unlike GET /videos/{id}: the generation runs in the POST's
 * `after()` callback and the cron sweeper closes out anything that dies, so
 * polling drives nothing and a caller who stops polling loses nothing either.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKey(req, async (auth) => {
    const { id } = await ctx.params;
    // Strict uuid before the query: a 36-char non-uuid makes Postgres' cast throw
    // inside the WHERE, which withApiKey would render as 500 for what is a miss.
    if (!UUID_RX.test(id)) return apiError('not_found', 404, 'No such generation.');

    // Nothing is generated or stored here, so only the stub-mode database guard
    // applies — a poll must keep working while the providers are down.
    const pre = providerPreflight({ r2: false });
    if (pre) return pre;

    const [job] = await db()
      .select()
      .from(genJobs)
      // Tenant scoping is the WHERE clause, not a post-hoc check: another
      // tenant's id must be indistinguishable from one that never existed. kind
      // too, so a tts or avatar job id is not readable as an image.
      .where(and(eq(genJobs.id, id), eq(genJobs.userId, auth.userId), eq(genJobs.kind, IMAGE_JOB_KIND)))
      .limit(1);
    if (!job) return apiError('not_found', 404, 'No such generation.');

    const [asset] = job.mediaAssetId
      ? await db().select().from(mediaAssets).where(eq(mediaAssets.id, job.mediaAssetId)).limit(1)
      : [];

    // Never announce a completion we cannot deliver. `completed` with a null
    // image_url is what made an integrator discard an image they had paid for, so
    // an unresolvable asset is reported as still pending — the honest answer, and
    // the caller's poll loop simply continues. completeImageJob's transaction
    // should make this unreachable; the warn is how we learn if it isn't.
    const imageUrl = job.status === 'completed' ? (asset?.publicUrl ?? null) : null;
    const status = job.status === 'completed' && !imageUrl ? 'pending' : job.status;
    if (status !== job.status) {
      console.warn('[v1/images] job', job.id, 'is completed with no resolvable asset; reporting pending');
    }

    return Response.json({
      id: job.id,
      status,
      image_url: imageUrl,
      // What the ledger debited. A failed job is refunded automatically, so this
      // is history, not your current balance — see GET /api/v1/me.
      credits_charged: job.creditsCharged ?? 0,
      // Already a public code when it is written; nothing internal reaches here.
      error: job.status === 'failed' ? (job.error ?? 'generation_failed') : null,
    });
  });
}
