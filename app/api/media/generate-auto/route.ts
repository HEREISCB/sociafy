import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { isStubMode } from '../../../../lib/env';
import { draftFromPlan, finalizePlan, summaryFor, type Plan } from '../../../../lib/ai/videoBrain';
import { priceCinemaRender } from '../../../../lib/ai/cue';
import { ensureAudioLine } from '../../../../lib/ai/prompt-rewriter';
import { attachmentSchema, brainContext } from '../../../../lib/media/autoVideo';
import { MotionNotReady, submitMotionAiVideo, submitMotionVideo } from '../../../../lib/media/motionJob';
import { startHybrid } from '../../../../lib/media/hybridJob';
import { InsufficientCreditsError, insufficientCreditsResponse } from '../../../../lib/credits/ledger';
import { fetchReferenceImages, rehostReferences, submitVideo, SubmitFailure } from '../../v1/shared';

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
  durationSec: z.number().int().min(1).max(30),
  aspect: z.enum(['9:16', '1:1', '16:9']),
  audio: z.object({ narration: z.boolean(), music: z.boolean(), sfx: z.boolean() }).partial().optional(),
  onScreenText: z.array(z.string().max(200)).max(10).optional(),
  signals: z.array(z.string().max(4)).max(20).optional(),
  estimatedCredits: z.number().int().nonnegative(),
});

const bodySchema = z.object({
  text: z.string().trim().min(2).max(4_000),
  plan: planSchema,
  platforms: z.array(z.string().trim().max(20)).max(10).default([]),
  attachments: z.array(attachmentSchema).max(9).default([]),
});

type JobOut = { id: string; status: string; durationSec: number; aspect: string; creditsCharged: number };

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
      return jsonError('plan_changed', 409, { plan: fresh, estimatedCredits: fresh.estimatedCredits, summary: summaryFor(fresh), reasons: fresh.reasons });
    }
    // Unaffordable plans are shown (priced) but never run: refuse before any re-host, insert or charge.
    if (fresh.estimatedCredits > balance) return insufficientCreditsResponse({ balance, needed: fresh.estimatedCredits });

    try {
      // Stills for image-to-video / reference footage: fetched, checked and re-hosted before any charge.
      let imageUrls: string[] | undefined;
      const f = fresh.footage;
      if (f && f.mode !== 'text') {
        const images = attachments.filter((a) => a.mimeType.startsWith('image/')).map((a) => a.url);
        const fetched = await fetchReferenceImages(images.slice(0, f.mode === 'image-to-video' ? 1 : 9));
        if (!fetched.ok) return fetched.response;
        imageUrls = await rehostReferences(user.id, fetched.files);
      }

      let job: JobOut;
      if (fresh.format === 'ai_video' && f) {
        const cinema = f.engine === 'cinema-1';
        const r = await submitVideo({
          auth: { userId: user.id },
          model: cinema ? 'sociafy-cinema-1' : 'sociafy-motion-1',
          prompt: cinema ? ensureAudioLine(f.prompt) : f.prompt,
          durationSec: f.seconds, quality: f.quality, aspect: fresh.aspect, fast: f.engine === 'motion-1-fast',
          genMode: f.mode, imageUrls, source: null, via: 'compose',
        });
        job = out(r.job, r.creditsCharged);
      } else if (fresh.format === 'hybrid') {
        const r = await startHybrid({ userId: user.id, plan: fresh, topic: text, imageUrls, via: 'compose' });
        job = { ...out(r.job, r.creditsCharged), status: 'pending' };
      } else if (fresh.graphics?.engine === 'template' && fresh.graphics.template) {
        const r = await submitMotionVideo({ userId: user.id, template: fresh.graphics.template, aspect: fresh.aspect as '9:16' | '16:9', topic: text.slice(0, 2_000), via: 'compose' });
        job = out(r.job, r.creditsCharged);
      } else {
        const r = await submitMotionAiVideo({ userId: user.id, aspect: fresh.aspect, durationSec: fresh.durationSec, topic: text, audio: fresh.audio, via: 'compose' });
        job = out(r.job, r.creditsCharged);
      }
      return new Response(
        JSON.stringify({ kind: fresh.format, jobs: [job], creditsChargedTotal: job.creditsCharged }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    } catch (e) {
      if (e instanceof MotionNotReady) {
        return jsonError('brand_kit_incomplete', 400, { hint: 'Add your brand name and main color in Brand kit first. Nothing was charged.' });
      }
      if (e instanceof InsufficientCreditsError) return insufficientCreditsResponse({ balance: e.balance, needed: e.needed });
      if (e instanceof SubmitFailure && e.code === 'at_capacity') {
        return jsonError('video_at_capacity', 503, { hint: 'Video rendering is busy right now. Nothing was charged — try again in a few minutes.' });
      }
      if (e instanceof SubmitFailure && e.code === 'prompt_rejected') return jsonError('prompt_rejected', 400);
      // White-label: engine detail goes to the log only. Any charge was refunded by the submit path.
      console.error('[generate-auto] submit failed:', e instanceof Error ? e.message.slice(0, 400) : e);
      return jsonError('video_submit_failed', 502);
    }
  }, req);
}

const out = (j: { id: string; status: string; durationSec: number; aspect: string }, creditsCharged: number): JobOut => ({
  id: j.id, status: j.status, durationSec: j.durationSec, aspect: j.aspect, creditsCharged,
});
