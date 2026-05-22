import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { rewritePromptForMedia } from '../../../../lib/ai/prompt-rewriter';
import { loadBrandContext, renderBrandBlock } from '../../../../lib/ai/brand-context';
import { getOpenAI } from '../../../../lib/ai/client';
import { db } from '../../../../lib/db';
import { videoJobs } from '../../../../lib/db/schema';
import { createSeedanceTask, type SeedanceMode, type SeedanceAspect, type SeedanceQuality } from '../../../../lib/ai/piapi';
import { priceForVideo } from '../../../../lib/credits/pricing';
import { ensureBalance, charge, refund, insufficientCreditsResponse } from '../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
  referenceImageUrls: z.array(z.string().url().max(2_000)).max(9).optional(),
  referenceVideoUrl: z.string().url().max(2_000).optional(),
  audioUrl: z.string().url().max(2_000).optional(),
  /** Trade quality for speed. Default false (uses seedance-2). */
  fast: z.boolean().default(false),
});

type GenMode = z.infer<typeof bodySchema>['genMode'];

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

    // Credit pre-flight. Pricing is per-job and depends on duration+quality
    // (1080p costs 5× 480p — see docs/pricing.md). We reserve the worst case
    // (all `count` submissions succeed) upfront, then refund any that fail
    // submission. Job-completion refunds (PiAPI says "failed" later) happen
    // in the polling endpoint.
    const perJob = priceForVideo({ durationSec, quality: quality as '480p' | '720p' | '1080p', fast });
    const totalCost = perJob.credits * count;
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

    // 2. Submit `count` parallel tasks. Each is independent — client polls
    //    each job and adds the finished clips as they land. We charge ONE
    //    ledger row per submitted job so a partial failure → only the
    //    successful jobs charge, and a later runtime failure → that job's
    //    specific ledger entry gets refunded.
    const apiKey = process.env.PIAPI_API_KEY;
    const seedance = mapToSeedanceInput({
      genMode, startFrameUrl, endFrameUrl, referenceImageUrls, referenceVideoUrl, audioUrl,
    });
    const submissions = await Promise.allSettled(
      Array.from({ length: count }, async () => {
        const taskId = await createSeedanceTask({
          prompt: rewrite.prompt,
          ...seedance,
          durationSec,
          aspect: aspect as SeedanceAspect,
          resolution: quality as SeedanceQuality,
          fast,
          apiKey,
        });
        // Charge per-job AFTER submission succeeds. PiAPI charges us on
        // task creation so this is when the cost actually lands.
        const charged = await charge({
          userId: user.id,
          action: perJob.action,
          credits: perJob.credits,
          meta: { providerTaskId: taskId, durationSec, quality, aspect, fast, genMode },
        });
        const [row] = await db()
          .insert(videoJobs)
          .values({
            userId: user.id,
            provider: fast ? 'piapi-seedance-2-fast' : 'piapi-seedance-2',
            providerTaskId: taskId,
            status: 'pending',
            prompt,
            rewrittenPrompt: rewrite.prompt,
            durationSec,
            aspect,
            quality,
            genMode,
            creditLedgerId: charged.ledgerId,
            creditsCharged: perJob.credits,
          })
          .returning();
        return row;
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
          creditsCharged: r.creditsCharged,
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
