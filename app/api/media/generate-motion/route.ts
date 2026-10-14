import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { isStubMode } from '../../../../lib/env';
import { MOTION_ASPECTS, MOTION_GRAPHICS, MOTION_TEMPLATE_IDS } from '../../../../lib/ai/models';
import { motionConfigured } from '../../../../lib/ai/motion';
import { MotionNotReady, submitMotionVideo } from '../../../../lib/media/motionJob';
import { InsufficientCreditsError, insufficientCreditsResponse } from '../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  /** The post text — the copy is written from it. */
  topic: z.string().trim().min(2).max(2_000),
  template: z.enum(MOTION_TEMPLATE_IDS as [string, ...string[]]),
  aspect: z.enum(MOTION_ASPECTS).default('9:16'),
});

/**
 * POST /api/media/generate-motion → 202 { model, jobs: [{ id, … }] }
 * A brand-kit motion graphic. Polls through /api/media/video-job/[id] like any
 * other video. 404 when the engine isn't configured (feature off).
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (!motionConfigured()) return jsonError('not_found', 404);
    if (isStubMode.r2()) return jsonError('r2_not_configured', 503);
    const rl = rateLimit('agentRun', `vidgen:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });

    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const { topic, aspect } = parsed.data;
    const template = parsed.data.template as (typeof MOTION_TEMPLATE_IDS)[number];

    try {
      const { job, creditsCharged } = await submitMotionVideo({ userId: user.id, template, aspect, topic, via: 'compose' });
      return new Response(
        JSON.stringify({
          model: MOTION_GRAPHICS.name,
          jobs: [{ id: job.id, status: job.status, durationSec: job.durationSec, aspect: job.aspect, creditsCharged }],
          creditsChargedTotal: creditsCharged,
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    } catch (e) {
      if (e instanceof MotionNotReady) {
        return jsonError('brand_kit_incomplete', 400, { hint: 'Add your brand name, logo and main color in Brand kit first. Nothing was charged.' });
      }
      if (e instanceof InsufficientCreditsError) return insufficientCreditsResponse({ balance: e.balance, needed: e.needed });
      // White-label: engine detail goes to the log only. Any charge was refunded in submitMotionVideo.
      console.error('[generate-motion] submit failed:', e instanceof Error ? e.message.slice(0, 400) : e);
      return jsonError('video_submit_failed', 502);
    }
  }, req);
}
