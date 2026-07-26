import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiKey } from '../../../../lib/api-key';
import { rateLimit } from '../../../../lib/rate-limit';
import { InsufficientCreditsError } from '../../../../lib/credits/ledger';
import { priceForVideo } from '../../../../lib/credits/pricing';
import { apiError, providerPreflight, readIdempotencyKey, submitVideo, webhookConfigFor } from '../shared';

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

    // Burst guard on top of the spend cap. In-process only (see lib/rate-limit),
    // so it thins bursts per instance; the daily cap is the real ceiling.
    const rl = rateLimit('agentRun', `v1vid:${auth.apiKeyId}`);
    if (!rl.ok) {
      return apiError('rate_limited', 429, 'Too many requests. Retry shortly.', {
        retry_after_sec: rl.retryAfterSec,
      });
    }

    const idem = readIdempotencyKey(req);
    if (!idem.ok) return idem.response;

    const raw = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError('invalid_request', 400, 'Request body failed validation.', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const body = parsed.data;

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
      // Everything else is an upstream rejection whose detail must not escape:
      // provider names and raw error bodies are both a leak and a lock-in.
      console.error('[v1/videos] submit failed:', e instanceof Error ? e.message : e);
      return apiError('upstream_error', 502, 'The generation provider rejected the request. No credits were charged.');
    }

    const price = priceForVideo({ durationSec: body.duration_sec, quality: body.quality, fast: body.fast });
    return new Response(
      JSON.stringify({
        id: result.job.id,
        status: 'pending',
        // From the price table, not the row: an unconfirmed-submit row is the
        // pre-charge snapshot, so its credits_charged column is still null.
        credits_charged: result.replayed ? result.creditsCharged : price.credits,
        duration_sec: body.duration_sec,
        quality: body.quality,
        aspect: body.aspect,
        poll_url: `/api/v1/videos/${result.job.id}`,
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
