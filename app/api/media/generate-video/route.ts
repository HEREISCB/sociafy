import { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { rewritePromptForMedia } from '../../../../lib/ai/prompt-rewriter';
import { loadBrandContext, renderBrandBlock } from '../../../../lib/ai/brand-context';
import { getOpenAI } from '../../../../lib/ai/client';
import { isStubMode } from '../../../../lib/env';
import { keyFromPublicUrl } from '../../../../lib/storage/r2';
import { db } from '../../../../lib/db';
import { mediaAssets, videoJobs } from '../../../../lib/db/schema';
import { createSeedanceTask, type SeedanceMode, type SeedanceAspect, type SeedanceQuality } from '../../../../lib/ai/piapi';
import { priceForVideo } from '../../../../lib/credits/pricing';
import { ensureBalance, charge, refund, insufficientCreditsResponse } from '../../../../lib/credits/ledger';
// Same fetcher + re-hoster /api/v1/videos uses. Imported rather than
// reimplemented: a second copy of an SSRF guard is a second copy to get wrong.
import { fetchReferenceImages, rehostReferences } from '../../v1/shared';

export const runtime = 'nodejs';
// Submitting a non-text mode now fetches the caller's stills first (up to
// REFERENCE_LIMITS.totalBudgetMs), re-hosts them, and then waits on PiAPI's own
// 30s submit timeout — which does not fit in 60. Matches /api/v1/videos. A text
// submit still answers in a second or two; this is a ceiling, not a delay.
export const maxDuration = 300;

const bodySchema = z.object({
  prompt: z.string().min(2).max(2_000),
  durationSec: z.number().int().min(4).max(15).default(8),
  quality: z.enum(['480p', '720p', '1080p']).default('720p'),
  aspect: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
  count: z.number().int().min(1).max(3).default(1),
  caption: z.string().max(2_000).optional(),
  rawPrompt: z.boolean().default(false),
  genMode: z.enum(['text', 'image-to-video', 'reference', 'audio-driven']).default('text'),
  startFrameUrl: z.string().url().max(2_000).optional(),
  endFrameUrl: z.string().url().max(2_000).optional(),
  /** Still 9 where v1 caps at 4: REFERENCE_LIMITS.maxTotalBytes bounds the
   *  buffered memory whatever the count is, so nine URLs only means each gets a
   *  smaller share of the same 48MB — a clean 400, never an OOM. */
  referenceImageUrls: z.array(z.string().url().max(2_000)).max(9).optional(),
  referenceVideoUrl: z.string().url().max(2_000).optional(),
  audioUrl: z.string().url().max(2_000).optional(),
  /** Trade quality for speed. Default false (uses seedance-2). */
  fast: z.boolean().default(false),
});

type GenMode = z.infer<typeof bodySchema>['genMode'];

/** Submit errors where no HTTP response arrived, so PiAPI may still have
 *  accepted the task. ENOTFOUND / ECONNREFUSED are NOT here: those never
 *  reached PiAPI, so they're definitive and refund immediately. */
const AMBIGUOUS_SUBMIT_RX = /ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|socket hang up/i;

/** Hard ceiling on reference-clip length. Seedance charges (unit_price / 2) per
 *  input second, so a 10-minute input costs multiples of the generation itself.
 *  Reference clips are short by nature; pricing alone wouldn't stop a user with
 *  a big balance from handing us one. */
const MAX_REF_INPUT_SEC = 60;

/**
 * Map our UI genMode + anchors onto PiAPI's Seedance input shape.
 *
 * - text         → text_to_video, no anchors
 * - image-to-vid → first_last_frames, image_urls = [start, ...end?]
 * - reference    → omni_reference, image_urls = refs (max 9), video_urls = [refVideo?]
 * - audio-driven → text_to_video (Seedance has no dedicated audio mode; audio_urls
 *                   piggybacks on text-to-video to drive lip-sync / beat-sync).
 */
function mapToSeedanceInput(args: {
  genMode: GenMode;
  startFrameUrl?: string;
  endFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrl?: string;
  audioUrl?: string;
}): { mode: SeedanceMode; imageUrls?: string[]; videoUrls?: string[]; audioUrls?: string[] } {
  switch (args.genMode) {
    case 'image-to-video':
      return {
        mode: 'first_last_frames',
        imageUrls: [args.startFrameUrl!, ...(args.endFrameUrl ? [args.endFrameUrl] : [])],
      };
    case 'reference':
      return {
        mode: 'omni_reference',
        imageUrls: args.referenceImageUrls,
        videoUrls: args.referenceVideoUrl ? [args.referenceVideoUrl] : undefined,
      };
    case 'audio-driven':
      return {
        mode: 'text_to_video',
        audioUrls: args.audioUrl ? [args.audioUrl] : undefined,
      };
    case 'text':
    default:
      return { mode: 'text_to_video' };
  }
}

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (!getOpenAI()) return jsonError('ai_not_configured', 503);
    if (!process.env.PIAPI_API_KEY) {
      return jsonError('video_provider_not_configured', 503, {
        hint: 'Set PIAPI_API_KEY in .env.local — get a key at https://piapi.ai',
      });
    }
    // R2 is a hard requirement, not a nice-to-have: the finished MP4 only
    // exists on PiAPI's CDN for a few hours. Without a bucket we'd charge the
    // user, pay PiAPI, and have nowhere to put the result. Same pre-flight as
    // generate-image.
    if (isStubMode.r2()) {
      return jsonError('r2_not_configured', 503, {
        hint: 'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, NEXT_PUBLIC_R2_PUBLIC_URL_BASE.',
      });
    }

    const rl = rateLimit('agentRun', `vidgen:${user.id}`);
    if (!rl.ok) {
      return new Response(JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) },
      });
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;
    const {
      prompt, durationSec, quality, aspect, count, caption, rawPrompt, genMode,
      startFrameUrl, endFrameUrl, referenceImageUrls, referenceVideoUrl, audioUrl, fast,
    } = parsed.data;

    // Pre-flight: each gen mode needs its own anchors.
    if (genMode === 'image-to-video' && !startFrameUrl) {
      return jsonError('image_to_video_needs_start_frame', 400);
    }
    if (genMode === 'reference' && !(referenceImageUrls?.length || referenceVideoUrl)) {
      return jsonError('reference_mode_needs_a_reference', 400);
    }
    if (genMode === 'audio-driven' && !audioUrl) {
      return jsonError('audio_driven_needs_audio_url', 400);
    }

    // Reference VIDEO carries a per-input-second surcharge (COSTS.md: Seedance
    // charges (unit_price / 2) × input_duration on top of the output price). It
    // is priced below via priceForVideo's inputDurationSec; here we bound it:
    // the input must be this caller's own upload (so it went through
    // /api/media/upload's 50MB cap rather than being an arbitrary hours-long
    // URL), and we submit exactly one clip instead of up to 3.
    // (Only reference mode forwards the video to Seedance — see mapToSeedanceInput.)
    const refVideo = genMode === 'reference' ? referenceVideoUrl : undefined;
    if (refVideo && !keyFromPublicUrl(refVideo).startsWith(`users/${user.id}/`)) {
      return jsonError('reference_video_must_be_uploaded', 400, {
        hint: 'Upload the reference clip to /api/media/upload and pass the returned publicUrl.',
      });
    }
    const effectiveCount = refVideo ? 1 : count;

    // Input duration comes from our own probe at upload time, never from the
    // client — it is a billing input. Unknown ⇒ we cannot price the surcharge,
    // so refuse rather than generate at an unpriced cost.
    let refInputSec: number | undefined;
    if (refVideo) {
      const [asset] = await db()
        .select({ durationS: mediaAssets.durationS })
        .from(mediaAssets)
        .where(and(
          eq(mediaAssets.userId, user.id),
          eq(mediaAssets.storageKey, keyFromPublicUrl(refVideo)),
        ))
        .limit(1);
      const secs = asset?.durationS != null ? Number(asset.durationS) : NaN;
      if (!Number.isFinite(secs) || secs <= 0) {
        return jsonError('reference_video_duration_unknown', 400, {
          hint: 'We could not read the clip length, so we cannot price it. Re-upload it as MP4 or MOV.',
        });
      }
      if (secs > MAX_REF_INPUT_SEC) {
        return jsonError('reference_video_too_long', 400, {
          durationSec: Math.round(secs), maxSec: MAX_REF_INPUT_SEC,
          hint: `Trim the reference clip to ${MAX_REF_INPUT_SEC}s or less.`,
        });
      }
      refInputSec = secs;
    }

    // Stills the provider would otherwise fetch from a URL the caller chose.
    // Fetch, validate and re-host them BEFORE the charge — a signed or private
    // URL fails opaquely inside PiAPI after we have already billed, and a
    // customer's own host is not ours to hand to a third party. Every rejection
    // here is the caller's input and costs nothing.
    let stills = genMode === 'reference'
      ? referenceImageUrls
      : genMode === 'image-to-video'
        ? [startFrameUrl!, ...(endFrameUrl ? [endFrameUrl] : [])]
        : undefined;
    if (stills?.length) {
      const fetched = await fetchReferenceImages(stills);
      if (!fetched.ok) return fetched.response;
      try {
        stills = await rehostReferences(user.id, fetched.files);
      } catch (e) {
        // Nothing is charged yet, and the provider cannot fetch what we could
        // not store.
        console.error('[generate-video] reference re-host failed:', e instanceof Error ? e.message : e);
        return jsonError('r2_not_configured', 503, {
          hint: 'We could not store your reference images. Nothing was charged — try again.',
        });
      }
    }

    // Credit pre-flight. Pricing is per-job and depends on duration+quality
    // (1080p costs 5× 480p — see docs/pricing.md). We reserve the worst case
    // (all submissions succeed) upfront, then refund any that fail submission.
    // Job-completion refunds (PiAPI says "failed" later) happen in
    // lib/media/finalizeVideoJob.
    const perJob = priceForVideo({
      durationSec, quality: quality as '480p' | '720p' | '1080p', fast,
      inputDurationSec: refInputSec,
    });
    const totalCost = perJob.credits * effectiveCount;
    const pre = await ensureBalance(user.id, totalCost);
    if (!pre.ok) {
      console.log('[generate-video] insufficient credits:', pre);
      return insufficientCreditsResponse({ balance: pre.balance, needed: pre.needed });
    }

    // 1. Rewrite prompt through the Seedance skill (verb-led, camera language)
    //    + brand context so the clip vibe stays on-brand.
    const brandCtx = await loadBrandContext(user.id);
    const brandBlock = renderBrandBlock(brandCtx, 'media');
    const rewrite = rawPrompt
      ? { prompt, enhanced: false }
      : await rewritePromptForMedia({ userPrompt: prompt, target: 'seedance-2', caption, brandBlock });

    // 2. Submit parallel tasks. Each is independent — client polls each job and
    //    adds the finished clips as they land. One ledger row per job so a
    //    later runtime failure refunds that job's specific charge.
    //
    //    Ordering matters: row → charge → submit. PiAPI's create call has a 30s
    //    timeout, and a socket that dies after the request was written means
    //    PiAPI may have accepted (and billed us for) the task. Submitting first
    //    made that case completely invisible — no ledger row, no video_jobs
    //    row. Now the row always exists before we can be billed, and the
    //    charge's meta.videoJobId cross-links the two.
    const apiKey = process.env.PIAPI_API_KEY;
    // OUR urls, never the caller's — see the re-host above.
    const seedance = mapToSeedanceInput({
      genMode,
      startFrameUrl: stills?.[0],
      endFrameUrl: stills?.[1],
      referenceImageUrls: stills,
      referenceVideoUrl,
      audioUrl,
    });
    // The row → charge → submit ordering below is duplicated by submitVideo() in
    // app/api/v1/shared.ts. Kept separate on purpose: this route carries count,
    // reference mode and prompt rewriting, which v1 deliberately dropped so
    // Idempotency-Key maps 1:1 onto one charge. Both orderings are pinned by
    // tests (generatevideo.test.ts here, v1.test.ts there) — if you change the
    // ordering in one, change it in both.
    const submissions = await Promise.allSettled(
      Array.from({ length: effectiveCount }, async () => {
        // providerTaskId '' = "not submitted yet"; finalizeVideoJob and the
        // cron sweeper treat it as the ambiguous state.
        const [row] = await db()
          .insert(videoJobs)
          .values({
            userId: user.id,
            provider: fast ? 'piapi-seedance-2-fast' : 'piapi-seedance-2',
            providerTaskId: '',
            status: 'pending',
            prompt,
            rewrittenPrompt: rewrite.prompt,
            durationSec,
            aspect,
            quality,
            genMode,
          })
          .returning();

        let charged;
        try {
          charged = await charge({
            userId: user.id,
            action: perJob.action,
            credits: perJob.credits,
            meta: {
              videoJobId: row.id, durationSec, quality, aspect, fast, genMode,
              // Surcharge is folded into `credits`; keep the inputs so a ledger
              // row can be re-derived (the action key alone can't explain it).
              ...(perJob.surcharge ? { refInputSec, refSurcharge: perJob.surcharge } : {}),
            },
          });
        } catch (e) {
          // Nothing was charged and nothing submitted — close the row so it
          // doesn't sit pending forever.
          await db().update(videoJobs)
            .set({ status: 'failed', error: 'charge_failed', updatedAt: new Date() })
            .where(eq(videoJobs.id, row.id));
          throw e;
        }
        await db().update(videoJobs)
          .set({ creditLedgerId: charged.ledgerId, creditsCharged: perJob.credits, updatedAt: new Date() })
          .where(eq(videoJobs.id, row.id));

        try {
          const taskId = await createSeedanceTask({
            prompt: rewrite.prompt,
            ...seedance,
            durationSec,
            aspect: aspect as SeedanceAspect,
            resolution: quality as SeedanceQuality,
            fast,
            apiKey,
          });
          const [live] = await db().update(videoJobs)
            .set({ providerTaskId: taskId, updatedAt: new Date() })
            .where(eq(videoJobs.id, row.id))
            .returning();
          return live;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (AMBIGUOUS_SUBMIT_RX.test(msg)) {
            // No HTTP response came back, so we can't tell whether PiAPI took
            // the task. Leave the row pending and task-id-less; the cron
            // sweeper closes it out (and refunds) after its grace window.
            await db().update(videoJobs)
              .set({ error: `submit_unconfirmed: ${msg.slice(0, 160)}`, updatedAt: new Date() })
              .where(eq(videoJobs.id, row.id));
            return row;
          }
          // Definitive rejection (PiAPI answered, or we never reached it) —
          // refund immediately.
          await db().update(videoJobs)
            .set({ status: 'failed', error: `submit_failed: ${msg.slice(0, 200)}`, updatedAt: new Date() })
            .where(eq(videoJobs.id, row.id));
          try {
            await refund({ userId: user.id, ledgerId: charged.ledgerId, reason: `submit_failed: ${msg.slice(0, 80)}` });
          } catch (re) {
            console.warn('[generate-video] refund failed:', re instanceof Error ? re.message : re);
          }
          throw e;
        }
      }),
    );

    const ok = submissions.filter((s) => s.status === 'fulfilled').map((s) => (s as PromiseFulfilledResult<typeof videoJobs.$inferSelect>).value);
    const fail = submissions.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

    if (ok.length === 0) {
      const reason = fail[0]?.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'unknown');
      console.error('[generate-video] all PiAPI submissions failed:', msg.slice(0, 400));
      return jsonError('video_submit_failed', 502, { detail: msg.slice(0, 400) });
    }

    return new Response(
      JSON.stringify({
        jobs: ok.map((r) => ({
          id: r.id,
          providerTaskId: r.providerTaskId,
          status: r.status,
          durationSec: r.durationSec,
          aspect: r.aspect,
          quality: r.quality,
          // From perJob, not the row: the unconfirmed-submit row is the
          // pre-charge snapshot, so its creditsCharged column is still null.
          creditsCharged: perJob.credits,
        })),
        submitted: ok.length,
        failed: fail.length,
        rewrittenPrompt: rewrite.prompt,
        enhanced: rewrite.enhanced,
        creditsChargedTotal: perJob.credits * ok.length,
      }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    );
  }, req);
}
