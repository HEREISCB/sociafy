import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { rewritePromptForMedia } from '../../../../lib/ai/prompt-rewriter';
import { getOpenAI } from '../../../../lib/ai/client';

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
  // Optional anchors. Seedance accepts first/last frames to lock the
  // beginning/end of motion + reference images to lock subject/style.
  startFrameUrl: z.string().url().max(2_000).optional(),
  endFrameUrl: z.string().url().max(2_000).optional(),
  referenceImageUrls: z.array(z.string().url().max(2_000)).max(4).optional(),
});

/**
 * POST /api/media/generate-video
 *
 * Currently a structured stub. The Seedance 2.0 (PiAPI) integration is the
 * next plug-in — once PIAPI_KEY is set we'll submit the job, return a 202
 * with a job id, and let the webhook deliver the finished asset.
 *
 * For now: rewrites the prompt through our skill file so the UI loop is
 * exercised, then returns `pending: true` so the client can show a sensible
 * status. This means signing in + clicking Generate still does something
 * deterministic instead of silently failing.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (!getOpenAI()) return jsonError('ai_not_configured', 503);

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
    const { prompt, durationSec, quality, aspect, count, caption, rawPrompt, startFrameUrl, endFrameUrl, referenceImageUrls } = parsed.data;

    const rewrite = rawPrompt
      ? { prompt, enhanced: false }
      : await rewritePromptForMedia({ userPrompt: prompt, target: 'seedance-2', caption });

    if (!process.env.PIAPI_KEY) {
      return jsonError('video_provider_not_configured', 503, {
        rewrittenPrompt: rewrite.prompt,
        enhanced: rewrite.enhanced,
        hint: 'AI video provider not configured.',
      });
    }

    // Placeholder for the real video provider call. Anchors are accepted on
    // the contract so the UI can already collect them; once the provider is
    // wired they'll be forwarded as first_frame_url, last_frame_url, and
    // reference_image_urls.
    return new Response(
      JSON.stringify({
        pending: true,
        durationSec,
        quality,
        aspect,
        count,
        anchors: {
          startFrameUrl: startFrameUrl ?? null,
          endFrameUrl: endFrameUrl ?? null,
          referenceImageUrls: referenceImageUrls ?? [],
        },
        rewrittenPrompt: rewrite.prompt,
        enhanced: rewrite.enhanced,
      }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    );
  }, req);
}
