import { NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { withApiKey } from '../../../../lib/api-key';
import { rateLimit } from '../../../../lib/rate-limit';
import { db } from '../../../../lib/db';
import { mediaAssets } from '../../../../lib/db/schema';
import { getOpenAI, MODELS } from '../../../../lib/ai/client';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../../lib/storage/r2';
import { charge, refund } from '../../../../lib/credits/ledger';
import { priceForImage } from '../../../../lib/credits/pricing';
import {
  apiError,
  findChargeBySource,
  isUniqueViolation,
  patchChargeMeta,
  providerPreflight,
  readIdempotencyKey,
} from '../shared';

export const runtime = 'nodejs';
// Synchronous like the first-party route — a single image lands in ~10-40s.
export const maxDuration = 90;

/**
 * POST /api/v1/images — public metered image generation.
 *
 * Backed by OpenAI's images API, NOT the video provider. Nothing about either
 * backend is observable from here: same auth, same ledger, same error codes, and
 * the response returns an R2 URL on our own domain.
 *
 * `count` is absent by design (as on /videos): one image per request keeps
 * Idempotency-Key a 1:1 mapping onto one charge, which removes the entire
 * partial-refund branch that the first-party route needs.
 */
const bodySchema = z
  .object({
    prompt: z.string().min(2).max(2_000),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
    quality: z.enum(['low', 'medium', 'high']).default('medium'),
  })
  .strict();

export async function POST(req: NextRequest) {
  return withApiKey(req, async (auth) => {
    const pre = providerPreflight({ r2: true, openai: true });
    if (pre) return pre;
    const openai = getOpenAI();
    if (!openai) return apiError('service_unavailable', 503, 'Image generation is temporarily unavailable.');

    const rl = rateLimit('agentRun', `v1img:${auth.apiKeyId}`);
    if (!rl.ok) {
      return apiError('rate_limited', 429, 'Too many requests. Retry shortly.', {
        retry_after_sec: rl.retryAfterSec,
      });
    }

    const idem = readIdempotencyKey(req);
    if (!idem.ok) return idem.response;
    const source = idem.source;

    const raw = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError('invalid_request', 400, 'Request body failed validation.', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const { prompt, size, quality } = parsed.data;

    // Fast path for a retry whose original charge already landed. The unique
    // index in the catch below is the authority.
    if (source) {
      const replay = await replayOf(auth.userId, source);
      if (replay) return replay;
    }

    const unit = priceForImage(size, quality);
    let charged;
    try {
      charged = await charge({
        userId: auth.userId,
        action: unit.action,
        credits: unit.credits,
        meta: {
          // MANDATORY: the auth layer's daily-cap query reads meta.apiKeyId.
          apiKeyId: auth.apiKeyId,
          size,
          quality,
          via: 'api_v1',
          prompt: prompt.slice(0, 200),
          ...(source ? { source } : {}),
        },
      });
    } catch (e) {
      if (source && isUniqueViolation(e)) {
        const replay = await replayOf(auth.userId, source);
        if (replay) return replay;
        // Charged but the image isn't stored yet — an in-flight twin owns it.
        // 409 rather than a second charge or a fabricated success.
        return apiError('request_in_progress', 409, 'A request with this Idempotency-Key is still in flight.');
      }
      throw e; // InsufficientCreditsError → withApiKey renders the 402.
    }

    // Any failure past this point must return the money. Charging for an image
    // we never delivered is the one bug this endpoint cannot ship with.
    try {
      const res = await openai.images.generate(
        { model: MODELS.image, prompt, size, quality, n: 1 },
        { maxRetries: 0 },
      );
      const b64 = res.data?.[0]?.b64_json;
      if (!b64) throw new Error('no_image_returned');

      const buf = Buffer.from(b64, 'base64');
      const key = makeMediaKey(auth.userId, `api-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
      await uploadBuffer({ key, body: buf, contentType: 'image/png' });
      const [w, h] = size.split('x').map((n) => parseInt(n, 10));
      const [asset] = await db()
        .insert(mediaAssets)
        .values({
          userId: auth.userId,
          storageKey: key,
          publicUrl: publicUrlFor(key),
          mimeType: 'image/png',
          sizeBytes: buf.length,
          width: w,
          height: h,
          label: prompt.slice(0, 80),
        })
        .returning();

      // Lets an idempotent replay resolve to this asset instead of a 409.
      if (source) await patchChargeMeta(charged.ledgerId, { mediaAssetId: asset.id });

      return Response.json({ id: asset.id, image_url: asset.publicUrl, credits_charged: unit.credits });
    } catch (e) {
      try {
        await refund({ userId: auth.userId, ledgerId: charged.ledgerId, reason: 'image_generation_failed' });
      } catch (re) {
        console.warn('[v1/images] refund failed:', re instanceof Error ? re.message : re);
      }
      const status = (e as { status?: number }).status;
      console.error('[v1/images] generation failed:', e instanceof Error ? e.message : e);
      // A 400 from the provider is the caller's prompt (moderation, unsupported
      // content), not our outage — say so without echoing the provider's body.
      if (status === 400) {
        return apiError('prompt_rejected', 400, 'The prompt was rejected by the content filter. Credits were refunded.');
      }
      return apiError('upstream_error', 502, 'Image generation failed upstream. Credits were refunded.');
    }
  });
}

/** Resolve an idempotency source back to the asset its original charge produced. */
async function replayOf(userId: string, source: string): Promise<Response | null> {
  const original = await findChargeBySource(userId, source);
  if (!original) return null;
  const assetId = (original.meta as { mediaAssetId?: unknown } | null)?.mediaAssetId;
  if (typeof assetId !== 'string') {
    return apiError('request_in_progress', 409, 'A request with this Idempotency-Key is still in flight.');
  }
  const [asset] = await db().select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
  if (!asset || asset.userId !== userId) return null;
  return Response.json(
    { id: asset.id, image_url: asset.publicUrl, credits_charged: Math.abs(original.credits) },
    { headers: { 'idempotency-replay': 'true' } },
  );
}
