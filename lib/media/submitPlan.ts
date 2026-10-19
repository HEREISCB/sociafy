import { jsonError } from '../api';
import type { Attachment, Plan } from '../ai/videoBrain';
import { ensureAudioLine } from '../ai/prompt-rewriter';
import { MotionNotReady, submitMotionAiVideo, submitMotionVideo } from './motionJob';
import { startHybrid } from './hybridJob';
import { InsufficientCreditsError, insufficientCreditsResponse } from '../credits/ledger';
import { fetchReferenceImages, rehostReferences, submitVideo, SubmitFailure } from '../../app/api/v1/shared';

export type PlanJob = { id: string; status: string; durationSec: number; aspect: string; creditsCharged: number };

/**
 * Start the render for a finalized plan: ai_video / hybrid / template / AI
 * motion. Each submit path does its own row → charge → render, refunding on
 * failure. Stills for image-to-video / reference footage are fetched, checked
 * and re-hosted first, before any charge; a bad still comes back as
 * `{ response }` (nothing charged). Other failures throw — map with planSubmitError.
 * Shared by POST /api/media/generate-auto and POST /api/media/from-url/videos.
 */
export async function submitPlan(args: {
  userId: string;
  plan: Plan;
  text: string;
  attachments: Attachment[];
}): Promise<{ job: PlanJob } | { response: Response }> {
  const { userId, plan, text, attachments } = args;
  let imageUrls: string[] | undefined;
  const f = plan.footage;
  if (f && f.mode !== 'text') {
    const images = attachments.filter((a) => a.mimeType.startsWith('image/')).map((a) => a.url);
    const fetched = await fetchReferenceImages(images.slice(0, f.mode === 'image-to-video' ? 1 : 9));
    if (!fetched.ok) return { response: fetched.response };
    imageUrls = await rehostReferences(userId, fetched.files);
  }

  if (plan.format === 'ai_video' && f) {
    const cinema = f.engine === 'cinema-1';
    const r = await submitVideo({
      auth: { userId },
      model: cinema ? 'sociafy-cinema-1' : 'sociafy-motion-1',
      prompt: cinema ? ensureAudioLine(f.prompt) : f.prompt,
      durationSec: f.seconds, quality: f.quality, aspect: plan.aspect, fast: f.engine === 'motion-1-fast',
      genMode: f.mode, imageUrls, source: null, via: 'compose',
    });
    return { job: out(r.job, r.creditsCharged) };
  }
  if (plan.format === 'hybrid') {
    const r = await startHybrid({ userId, plan, topic: text, imageUrls, via: 'compose' });
    // A hybrid's parent row waits on its footage; to the caller it is simply pending.
    return { job: { ...out(r.job, r.creditsCharged), status: 'pending' } };
  }
  if (plan.graphics?.engine === 'template' && plan.graphics.template) {
    const r = await submitMotionVideo({ userId, template: plan.graphics.template, aspect: plan.aspect as '9:16' | '16:9', topic: text.slice(0, 2_000), via: 'compose' });
    return { job: out(r.job, r.creditsCharged) };
  }
  const r = await submitMotionAiVideo({ userId, aspect: plan.aspect, durationSec: plan.durationSec, topic: text, audio: plan.audio, via: 'compose' });
  return { job: out(r.job, r.creditsCharged) };
}

/** A submitPlan failure → the white-labelled response. Engine detail goes to the log only. */
export function planSubmitError(e: unknown, tag: string): Response {
  if (e instanceof MotionNotReady) {
    return jsonError('brand_kit_incomplete', 400, { hint: 'Add your brand name and main color in Brand kit first. Nothing was charged.' });
  }
  if (e instanceof InsufficientCreditsError) return insufficientCreditsResponse({ balance: e.balance, needed: e.needed });
  if (e instanceof SubmitFailure && e.code === 'at_capacity') {
    return jsonError('video_at_capacity', 503, { hint: 'Video rendering is busy right now. Nothing was charged — try again in a few minutes.' });
  }
  if (e instanceof SubmitFailure && e.code === 'prompt_rejected') return jsonError('prompt_rejected', 400);
  // Any charge was refunded by the submit path.
  console.error(`[${tag}] submit failed:`, e instanceof Error ? e.message.slice(0, 400) : e);
  return jsonError('video_submit_failed', 502);
}

const out = (j: { id: string; status: string; durationSec: number; aspect: string }, creditsCharged: number): PlanJob => ({
  id: j.id, status: j.status, durationSec: j.durationSec, aspect: j.aspect, creditsCharged,
});
