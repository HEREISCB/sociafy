import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiKey } from '../../../../lib/api-key';
import { rateLimit } from '../../../../lib/rate-limit';
import { InsufficientCreditsError } from '../../../../lib/credits/ledger';
import { priceForVideo } from '../../../../lib/credits/pricing';
import {
  apiError,
  providerPreflight,
  publicVideoError,
  readIdempotencyKey,
  SubmitFailure,
  submitVideo,
  webhookConfigFor,
} from '../shared';

export const runtime = 'nodejs';
// Submit only — we never hold the request open for the 30-120s generation.
export const maxDuration = 60;

/**
 * POST /api/v1/videos — public metered text-to-video.
 *
 * `.strict()` on purpose: a public money endpoint should 400 on an unknown
 * field rather than silently ignore it. A caller who typos `quality` and gets a
 * 720p bill they didn't ask for has a legitimate complaint.
 */
const bodySchema = z
  .object({
    prompt: z.string().min(2).max(2_000),
    duration_sec: z.number().int().min(4).max(15).default(8),
    quality: z.enum(['480p', '720p', '1080p']).default('720p'),
    aspect: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
    /** Trade quality for speed and cost. 1080p has no fast tier. */
    fast: z.boolean().default(false),
    /**
     * Text-to-video only in v1. `reference` is deliberately withheld: its price
     * includes an input-duration surcharge derived from a probe that returns
     * null for fragmented MP4 and WebM, so we cannot bill it correctly yet.
     */
    gen_mode: z.literal('text').default('text'),
  })
  .strict();

export async function POST(req: NextRequest) {
  return withApiKey(req, async (auth) => {
    const pre = providerPreflight({ r2: true, piapi: true });
    if (pre) return pre;

    const idem = readIdempotencyKey(req, 'videos');
    if (!idem.ok) return idem.response;

    const raw = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError('invalid_request', 400, 'Request body failed validation.', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const body = parsed.data;

    // Burst guard on top of the spend cap. In-process only (see lib/rate-limit),
    // so it thins bursts per instance; the daily cap is the real ceiling.
    // AFTER validation so a malformed request costs no token — §6 promises a 400
    // costs nothing, and a token is something.
    const rl = rateLimit('agentRun', `v1vid:${auth.apiKeyId}`);
    if (!rl.ok) {
      return apiError(
        'rate_limited',
        429,
        'Too many requests. Retry shortly.',
        { retry_after_sec: rl.retryAfterSec },
        { 'retry-after': String(rl.retryAfterSec) },
      );
    }

    let result;
    try {
      result = await submitVideo({
        auth,
        prompt: body.prompt,
        durationSec: body.duration_sec,
        quality: body.quality,
        aspect: body.aspect,
        fast: body.fast,
        source: idem.source,
        webhookConfig: webhookConfigFor(req),
      });
    } catch (e) {
      // Let withApiKey render the canonical 402 for a late balance failure.
      if (e instanceof InsufficientCreditsError) throw e;
      // Only a SubmitFailure is actually a provider rejection. The old catch-all
      // told every caller "the provider rejected the request, no credits were
      // charged" — wrong twice over: credits ARE charged and then refunded, and a
      // database fault after the charge is not a provider rejection at all.
      // Detail never escapes: provider names and raw bodies are a leak and a
      // lock-in.
      if (e instanceof SubmitFailure) {
        console.error('[v1/videos] submit failed:', e.code, e.detail.slice(0, 300));
        if (e.code === 'request_in_progress') {
          return apiError(
            'request_in_progress',
            409,
            'A request with this Idempotency-Key is still in flight. Retry the same key in a few seconds.',
          );
        }
        return apiError(
          'upstream_error',
          502,
          e.refunded
            ? 'The generation provider rejected the request. The credits charged for it were refunded.'
            : 'The generation provider rejected the request. The credits charged for it will be refunded automatically.',
        );
      }
      // Deliberately does NOT promise a refund. This is the one path where we
      // cannot: the cross-link write (video_jobs.credit_ledger_id) is what the
      // sweeper refunds against, so if that write is what failed the sweeper has
      // nothing to reverse. Say so instead of reassuring the caller falsely.
      console.error('[v1/videos] submit errored after the charge:', e instanceof Error ? e.message : e);
      return apiError(
        'internal',
        500,
        'The request failed on our side after the job was created, and has been logged. Credits may have been charged — check GET /api/v1/me and contact us if your balance looks wrong.',
      );
    }

    const price = priceForVideo({ durationSec: body.duration_sec, quality: body.quality, fast: body.fast });
    const job = result.job;
    return new Response(
      JSON.stringify({
        id: job.id,
        // The persisted row's status, not a hardcoded 'pending'. A replay of a key
        // whose job finished last week used to report "pending" forever.
        status: job.status,
        // From the price table on a fresh submit: an unconfirmed-submit row is the
        // pre-charge snapshot, so its credits_charged column is still null.
        credits_charged: result.replayed ? result.creditsCharged : price.credits,
        // The ORIGINAL job's parameters. Echoing the incoming body on a replay
        // mixed the new request's params with the old job's price.
        duration_sec: job.durationSec,
        quality: job.quality,
        aspect: job.aspect,
        // Surfaced here so a replay of an already-failed job doesn't send the
        // caller off to poll something that will never succeed.
        ...(job.status === 'failed' ? { error: publicVideoError(job.error) } : {}),
        poll_url: `/api/v1/videos/${job.id}`,
      }),
      {
        // 202 even on an idempotent replay: the caller's intent (one job) is
        // satisfied and the response body is identical, which is the point.
        status: 202,
        headers: { 'content-type': 'application/json', 'idempotency-replay': String(result.replayed) },
      },
    );
  });
}
