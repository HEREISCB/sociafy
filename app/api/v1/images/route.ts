import { NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { withApiKey } from '../../../../lib/api-key';
import { rateLimit } from '../../../../lib/rate-limit';
import { db } from '../../../../lib/db';
import { mediaAssets } from '../../../../lib/db/schema';
import { getOpenAI, MODELS } from '../../../../lib/ai/client';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../../lib/storage/r2';
import { charge, ensureBalance, InsufficientCreditsError, refund } from '../../../../lib/credits/ledger';
import { priceForImage } from '../../../../lib/credits/pricing';
import {
  apiError,
  classifyImageFailure,
  fetchReferenceImages,
  findChargeBySource,
  isUniqueViolation,
  logImageFailure,
  patchChargeMeta,
  providerPreflight,
  readIdempotencyKey,
  REFERENCE_LIMITS,
  releaseIdempotencySource,
} from '../shared';

export const runtime = 'nodejs';
// Synchronous like the first-party route. 90s was already marginal — medium
// quality has been measured at 66-78s, and a client with a 60s default timed out
// consistently. Reference images add up to REFERENCE_LIMITS.totalBudgetMs (45s)
// of fetching before generation even starts, plus the time to upload up to 48MB
// of them to the provider, so the combined worst case is ~2-3 minutes. Timing out
// AFTER the charge is the worst outcome this route has, so
// the ceiling goes to the platform maximum we already use elsewhere (the cron
// sweeper and the PiAPI webhook are both 300).
export const maxDuration = 300;

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
 *
 * `reference_images` switches the provider call to images.edit so the output can
 * resemble a real product rather than a description of one. The URLs are fetched
 * here, which makes this a trust boundary — see fetchReferenceImages in shared.
 */
const bodySchema = z
  .object({
    prompt: z.string().min(2).max(2_000),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
    quality: z.enum(['low', 'medium', 'high']).default('medium'),
    /**
     * Public https URLs of product photos to imitate. One field rather than a
     * singular `image_url` plus a plural, so there is never a question of
     * precedence; a one-element array is the single-reference case. Fetched and
     * validated by fetchReferenceImages — see REFERENCE_LIMITS.
     */
    reference_images: z.array(z.string()).min(1).max(REFERENCE_LIMITS.maxImages).optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  return withApiKey(req, async (auth) => {
    const pre = providerPreflight({ r2: true, openai: true });
    if (pre) return pre;
    const openai = getOpenAI();
    if (!openai) return apiError('service_unavailable', 503, 'Image generation is temporarily unavailable.');

    const idem = readIdempotencyKey(req, 'images');
    if (!idem.ok) return idem.response;
    const source = idem.source;

    const raw = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError('invalid_request', 400, 'Request body failed validation.', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const { prompt, size, quality, reference_images: referenceUrls } = parsed.data;

    // Rate limit AFTER validation: §6 of the docs promises a 400 costs nothing,
    // and it used to cost a token — three typos burned the whole burst budget.
    // Still before the charge, which is the thing worth limiting.
    const rl = rateLimit('agentRun', `v1img:${auth.apiKeyId}`);
    if (!rl.ok) {
      return apiError(
        'rate_limited',
        429,
        'Too many requests. Retry shortly.',
        { retry_after_sec: rl.retryAfterSec },
        { 'retry-after': String(rl.retryAfterSec) },
      );
    }

    // Fast path for a retry whose original charge already landed. The unique
    // index in the catch below is the authority.
    if (source) {
      const replay = await replayOf(auth.userId, source);
      if (replay) return replay;
    }

    // Reference images are fetched BEFORE the charge: every way they can be
    // wrong is the caller's own input, and §6 promises a 400 costs nothing. A
    // rejected reference must not be a charged reference.
    let refs: File[] | null = null;
    if (referenceUrls) {
      const fetched = await fetchReferenceImages(referenceUrls);
      if (!fetched.ok) return fetched.response;
      refs = fetched.files;
    }

    // Flat per reference — their resolution does not enter into it, because the
    // provider's input token count is bounded either way.
    const unit = priceForImage(size, quality, refs?.length);
    // Pre-flight so an under-funded key doesn't get as far as the provider.
    // `charge` below is still the authority (it re-checks under FOR UPDATE).
    const funded = await ensureBalance(auth.userId, unit.credits);
    if (!funded.ok) throw new InsufficientCreditsError(funded.balance, funded.needed);

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
          ...(refs ? { referenceImages: refs.length, referenceSurcharge: unit.surcharge } : {}),
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
      // images.edit is the only mechanism that takes input images. NOT sending
      // input_fidelity: the SDK's comment claims "gpt-image-1.5 and later", but
      // the live API answers 400 invalid_input_fidelity_model on gpt-image-2
      // (verified twice). Likeness is therefore guided, not pinned.
      const res = refs
        ? await openai.images.edit(
            { model: MODELS.image, image: refs, prompt, size, quality, n: 1 },
            { maxRetries: 0 },
          )
        : await openai.images.generate(
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

      // Header on the fresh path too, so `Idempotency-Replay` is always present
      // on both POSTs rather than only appearing on an images replay.
      return Response.json(
        { id: asset.id, image_url: asset.publicUrl, credits_charged: unit.credits },
        { headers: { 'idempotency-replay': 'false' } },
      );
    } catch (e) {
      let refunded = false;
      try {
        refunded = (await refund({
          userId: auth.userId,
          ledgerId: charged.ledgerId,
          reason: 'image_generation_failed',
        })).refunded;
      } catch (re) {
        console.warn('[v1/images] refund failed:', re instanceof Error ? re.message : re);
      }
      // A definitively failed attempt must give its Idempotency-Key back, or the
      // charge row (which a refund does not delete) makes every later retry a
      // permanent 409 — the docs' "retry the same key" could never succeed.
      // Gated on the refund landing: releasing an unrefunded charge's claim would
      // let the retry bill a second time.
      if (source && refunded) {
        await releaseIdempotencySource(charged.ledgerId);
      } else if (source) {
        console.error('[v1/images] refund not confirmed, keeping idempotency claim on', charged.ledgerId);
      }

      // Never `prompt_rejected` on a bare 400 — see classifyImageFailure. The
      // provider's real code and message go to the log, never to the caller.
      const failure = classifyImageFailure(e);
      logImageFailure('v1/images', e, failure);
      return apiError(failure.code, failure.status, failure.message);
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
