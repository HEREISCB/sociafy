import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { isStubMode } from '../../../../lib/env';
import { draftFromPlan, finalizePlan, type Plan } from '../../../../lib/ai/videoBrain';
import { MOTION_AI } from '../../../../lib/ai/models';
import { priceCinemaRender } from '../../../../lib/ai/cue';
import { attachmentSchema, brainContext } from '../../../../lib/media/autoVideo';
import { insufficientCreditsResponse } from '../../../../lib/credits/ledger';
import { planSubmitError, submitPlan } from '../../../../lib/media/submitPlan';

export const runtime = 'nodejs';
// Image-to-video fetches and re-hosts the stills before submitting (as generate-video).
export const maxDuration = 300;

const planSchema = z.object({
  format: z.enum(['ai_video', 'motion_graphic', 'hybrid']),
  recipe: z.string().max(4).nullable().optional(),
  graphics: z.object({
    engine: z.enum(['ai_motion', 'template']),
    template: z.enum(['stat', 'showcase', 'sting']).nullable().optional(),
  }).nullable().optional(),
  footage: z.object({
    engine: z.enum(['motion-1', 'motion-1-fast', 'cinema-1']),
    mode: z.enum(['text', 'image-to-video', 'reference']),
    seconds: z.number().int().min(1).max(30),
    quality: z.enum(['480p', '720p', '1080p']),
    prompt: z.string().max(2_000),
  }).nullable().optional(),
  durationSec: z.number().int().min(1).max(MOTION_AI.durationSec.max),
  aspect: z.enum(['9:16', '1:1', '16:9']),
  audio: z.object({ narration: z.boolean(), music: z.boolean(), sfx: z.boolean() }).partial().optional(),
  onScreenText: z.array(z.string().max(200)).max(10).optional(),
  signals: z.array(z.string().max(4)).max(20).optional(),
  summary: z.string().max(300).optional(),
  reasons: z.array(z.string().max(300)).max(6).optional(),
  estimatedCredits: z.number().int().nonnegative(),
});

const bodySchema = z.object({
  text: z.string().trim().min(2).max(4_000),
  plan: planSchema,
  platforms: z.array(z.string().trim().max(20)).max(10).default([]),
  attachments: z.array(attachmentSchema).max(9).default([]),
});

/**
 * POST /api/media/generate-auto → 202 { kind, jobs: [{ id, status, durationSec, aspect, creditsCharged }], creditsChargedTotal }
 *
 * Runs a plan from POST /api/media/plan-video. The plan is NOT trusted: it goes
 * back through the brain's deterministic post-pass and is re-priced here. If
 * the format changed or the price rose above what the user approved → 409
 * plan_changed with the fresh plan, nothing charged. Poll each job via
 * GET /api/media/video-job/[id] (a hybrid's id stays pending until it's done).
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.r2()) return jsonError('r2_not_configured', 503);
    const rl = rateLimit('agentRun', `vidgen:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const { text, plan: approved, attachments } = parsed.data;
    const platforms = parsed.data.platforms.map((p) => p.toLowerCase());

    const { availability, balance } = await brainContext(user.id);
    const fresh = finalizePlan(
      draftFromPlan(approved as Partial<Plan>),
      { text, platforms, attachments, availability, balance, overrides: { format: approved.format, durationSec: approved.durationSec, aspect: approved.aspect } },
      { revalidate: true },
    );
    // Cinema is billed off a live quote; check it against what the user approved before submitVideo charges it.
    if (fresh.footage?.engine === 'cinema-1') {
      try {
        const q = await priceCinemaRender({ durationSec: fresh.footage.seconds, quality: fresh.footage.quality === '480p' ? '480p' : '720p' });
        fresh.estimatedCredits = q.credits;
      } catch {
        return jsonError('video_submit_failed', 502, { hint: 'We could not price this video right now. Nothing was charged — try again.' });
      }
    }
    if (fresh.format !== approved.format || fresh.estimatedCredits > approved.estimatedCredits) {
      return jsonError('plan_changed', 409, { plan: fresh, estimatedCredits: fresh.estimatedCredits, summary: fresh.summary, reasons: fresh.reasons });
    }
    // Unaffordable plans are shown (priced) but never run: refuse before any re-host, insert or charge.
    if (fresh.estimatedCredits > balance) return insufficientCreditsResponse({ balance, needed: fresh.estimatedCredits });

    try {
      const r = await submitPlan({ userId: user.id, plan: fresh, text, attachments });
      if ('response' in r) return r.response;
      return new Response(
        JSON.stringify({ kind: fresh.format, jobs: [r.job], creditsChargedTotal: r.job.creditsCharged }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    } catch (e) {
      return planSubmitError(e, 'generate-auto');
    }
  }, req);
}

