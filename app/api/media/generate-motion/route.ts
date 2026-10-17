import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { isStubMode } from '../../../../lib/env';
import { MOTION_AI, MOTION_ASPECTS, MOTION_GRAPHICS, MOTION_TEMPLATE_IDS } from '../../../../lib/ai/models';
import { motionConfigured } from '../../../../lib/ai/motion';
import { motionAiConfigured } from '../../../../lib/ai/motionAi';
import { MotionNotReady, submitMotionAiVideo, submitMotionVideo } from '../../../../lib/media/motionJob';
import { InsufficientCreditsError, insufficientCreditsResponse } from '../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  /** The post text — the copy is written from it. */
  topic: z.string().trim().min(2).max(4_000),
  /** A template id, or 'ai' for an AI-designed motion graphic. */
  template: z.enum(['ai', ...MOTION_TEMPLATE_IDS] as [string, ...string[]]),
  aspect: z.enum(MOTION_AI.aspects).default('9:16'),
  /** 'ai' only; templates have fixed lengths. */
  durationSec: z.number().int().min(MOTION_AI.durationSec.min).max(MOTION_AI.durationSec.max).default(MOTION_AI.durationSec.default),
  /** 'ai' only. Omitted = silent. Voiceover or music adds 1 cr/s (priceForMotionAi). */
  audio: z.object({
    narration: z.boolean().default(false),
    sfx: z.boolean().default(false),
    music: z.boolean().default(false),
    voice: z.string().trim().regex(/^[A-Za-z0-9 ._'-]{1,60}$/).optional(),
    language: z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).optional(),
  }).strict().optional(),
});

/**
 * POST /api/media/generate-motion → 202 { model, jobs: [{ id, … }] }
 * A brand-kit motion graphic — a template, or (`template: 'ai'`) one designed
 * from the post text. Polls through /api/media/video-job/[id] like any other
 * video. 404 when the backend for the requested kind isn't configured.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (!motionConfigured() && !motionAiConfigured()) return jsonError('not_found', 404);
    if (isStubMode.r2()) return jsonError('r2_not_configured', 503);
    const rl = rateLimit('agentRun', `vidgen:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });

    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const { topic, aspect, durationSec, audio } = parsed.data;
    const ai = parsed.data.template === 'ai';
    if (!(ai ? motionAiConfigured() : motionConfigured())) return jsonError('not_found', 404);
    if (!ai && (aspect === '1:1' || topic.length > 2_000)) {
      return jsonError('invalid_body', 400, { hint: 'Templates render 9:16 or 16:9, from up to 2000 characters.' });
    }
    const template = parsed.data.template as (typeof MOTION_TEMPLATE_IDS)[number];

    try {
      const { job, creditsCharged } = ai
        ? await submitMotionAiVideo({ userId: user.id, aspect, durationSec, topic, audio, via: 'compose' })
        : await submitMotionVideo({ userId: user.id, template, aspect: aspect as (typeof MOTION_ASPECTS)[number], topic, via: 'compose' });
      return new Response(
        JSON.stringify({
          model: ai ? MOTION_AI.name : MOTION_GRAPHICS.name,
          jobs: [{ id: job.id, status: job.status, durationSec: job.durationSec, aspect: job.aspect, creditsCharged }],
          creditsChargedTotal: creditsCharged,
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    } catch (e) {
      if (e instanceof MotionNotReady) {
        return jsonError('brand_kit_incomplete', 400, {
          hint: ai
            ? 'Add your brand name and main color in Brand kit first. Nothing was charged.'
            : 'Add your brand name, logo and main color in Brand kit first. Nothing was charged.',
        });
      }
      if (e instanceof InsufficientCreditsError) return insufficientCreditsResponse({ balance: e.balance, needed: e.needed });
      // White-label: engine detail goes to the log only. Any charge was refunded in submitMotionVideo.
      console.error('[generate-motion] submit failed:', e instanceof Error ? e.message.slice(0, 400) : e);
      return jsonError('video_submit_failed', 502);
    }
  }, req);
}
