import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../../../lib/api';
import { parseBody } from '../../../../../../lib/validation';
import { rateLimit } from '../../../../../../lib/rate-limit';
import { isStubMode } from '../../../../../../lib/env';
import { motionAiConfigured } from '../../../../../../lib/ai/motionAi';
import { submitMotionAiEdit } from '../../../../../../lib/media/motionJob';
import { findMotionJob } from '../../../../../../lib/media/motionVersions';
import { InsufficientCreditsError, insufficientCreditsResponse } from '../../../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.object({
  /** Omitted = the whole video. */
  segmentId: z.string().trim().min(1).max(100).optional(),
  instruction: z.string().trim().min(1).max(1_000),
});

/**
 * POST /api/media/motion-ai/[jobId]/edit {segmentId?, instruction} → 202 { job }
 * Revise a finished AI-designed motion graphic. The result is a NEW asset
 * (the original stays in the library); poll it via /api/media/video-job/[id].
 * Charged priceForMotionAiEdit up front, refunded on a definite failure.
 * 404 when the worker isn't configured, or the job isn't the caller's own
 * completed AI-designed render. `jobId` may also be the media asset id.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withUser(async (user) => {
    const { jobId } = await ctx.params;
    if (!motionAiConfigured() || !UUID.test(jobId ?? '')) return jsonError('not_found', 404);
    if (isStubMode.r2()) return jsonError('r2_not_configured', 503);
    const rl = rateLimit('agentRun', `vidgen:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });

    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;

    const parent = await findMotionJob(user.id, jobId);
    if (!parent || parent.status !== 'completed' || !parent.mediaAssetId || !parent.providerTaskId) return jsonError('not_found', 404);

    try {
      const { job, creditsCharged } = await submitMotionAiEdit({
        userId: user.id, parent, segmentId: parsed.data.segmentId, instruction: parsed.data.instruction,
      });
      return new Response(
        JSON.stringify({
          job: { id: job.id, status: job.status, durationSec: job.durationSec, aspect: job.aspect, creditsCharged },
          creditsChargedTotal: creditsCharged,
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    } catch (e) {
      if (e instanceof InsufficientCreditsError) return insufficientCreditsResponse({ balance: e.balance, needed: e.needed });
      const msg = e instanceof Error ? e.message : String(e);
      // White-label: engine detail goes to the log only. Any charge was refunded in submitMotionAiEdit.
      console.error('[motion-edit] submit failed:', msg.slice(0, 400));
      if (/^motion_ai_404/.test(msg)) {
        return jsonError('edit_unavailable', 409, { hint: "This version can’t be edited anymore. Your credits were returned." });
      }
      return jsonError('video_submit_failed', 502);
    }
  }, req);
}
