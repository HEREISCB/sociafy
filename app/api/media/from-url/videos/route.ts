import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../../lib/api';
import { parseBody } from '../../../../../lib/validation';
import { rateLimit } from '../../../../../lib/rate-limit';
import { isStubMode } from '../../../../../lib/env';
import { db } from '../../../../../lib/db';
import { drafts, PLATFORMS } from '../../../../../lib/db/schema';
import { planVideo, type Attachment } from '../../../../../lib/ai/videoBrain';
import { MOTION_AI } from '../../../../../lib/ai/models';
import { brainContext } from '../../../../../lib/media/autoVideo';
import { planSubmitError, submitPlan } from '../../../../../lib/media/submitPlan';
import { MAX_PRODUCTS } from '../../../../../lib/ai/site-products';
import { InsufficientCreditsError, insufficientCreditsResponse } from '../../../../../lib/credits/ledger';

export const runtime = 'nodejs';
// Up to 8 renders started one after another, each possibly re-hosting a product photo.
export const maxDuration = 300;

const bodySchema = z.object({
  products: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    postText: z.string().trim().min(2).max(4_000),
    imageUrls: z.array(z.string().url().max(2_000).refine((u) => u.startsWith('https://'), 'https only')).max(4).default([]),
  })).min(1).max(MAX_PRODUCTS),
  platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).default([]),
  durationSec: z.number().int().min(4).max(MOTION_AI.durationSec.max).optional(),
  /** Plan and price only: nothing is charged or created. */
  dryRun: z.boolean().optional(),
  /** For placing the new posts on Home's plan (the user's slots). */
});

// The product photos only feed the planner and the footage; what they really are is checked when fetched.
const attachmentsOf = (urls: string[]): Attachment[] => urls.map((url) => ({ url, mimeType: 'image/*' }));

/**
 * POST /api/media/from-url/videos { products: [{ name, postText, imageUrls }], platforms, durationSec?, dryRun? }
 *   dryRun → 200 { plans: [{ name, format, summary, estimatedCredits }], totalCredits, balance, affordable }
 *   else   → 202 { drafts: [{ id, name, videoJobId, estimatedCredits }], failed: [{ name, error, hint? }] }
 *
 * One video per product, as one post per product: the video brain plans each
 * (its caption + photos), the whole batch is checked against the balance up
 * front (402, nothing charged), then each render starts through the same submit
 * path as generate-auto and a draft is created pointing at it (drafts.videoJobId).
 * The five-minute finalize sweep (attachFinishedVideos) attaches each clip when
 * it lands; the drafts sit on Home for review meanwhile.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.r2()) return jsonError('r2_not_configured', 503);
    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const { products, platforms, durationSec, dryRun } = parsed.data;
    const rl = rateLimit(dryRun ? 'videoPlan' : 'agentRun', `${dryRun ? 'fromurl-plan' : 'fromurl-vid'}:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });

    const start = new Date();
    const ctx = await brainContext(user.id);
    const results = await Promise.all(products.map((p) => planVideo(
      { userId: user.id, text: p.postText, platforms, attachments: attachmentsOf(p.imageUrls), ...(durationSec ? { overrides: { durationSec } } : {}) },
      ctx,
    )));
    if (results.some((r) => r.plan.format === 'none')) {
      return jsonError('video_unavailable', 503, { hint: 'Video is not available on your account yet. Nothing was charged.' });
    }
    const total = results.reduce((s, r) => s + r.estimatedCredits, 0);
    if (dryRun) {
      return {
        plans: products.map((p, i) => ({ name: p.name, format: results[i].plan.format, summary: results[i].summary, estimatedCredits: results[i].estimatedCredits })),
        totalCredits: total, balance: ctx.balance, affordable: total <= ctx.balance,
      };
    }
    if (total > ctx.balance) return insufficientCreditsResponse({ balance: ctx.balance, needed: total });

    const made: { id: string; name: string; videoJobId: string; estimatedCredits: number }[] = [];
    const failed: { name: string; error: string; hint?: string }[] = [];
    let firstFailure: Response | null = null;
    for (const [i, p] of products.entries()) {
      const plan = results[i].plan;
      let fail: Response;
      let stop = false;
      try {
        const r = await submitPlan({ userId: user.id, plan, text: p.postText, attachments: attachmentsOf(p.imageUrls) });
        if ('job' in r) {
          try {
            // planned_at = now lists it on Home for review; it isn't scheduled until the user picks a time.
            const [d] = await db().insert(drafts).values({
              userId: user.id, title: p.name, body: p.postText, targetPlatforms: platforms,
              videoJobId: r.job.id, plannedAt: start, source: 'user',
            }).returning({ id: drafts.id });
            made.push({ id: d.id, name: p.name, videoJobId: r.job.id, estimatedCredits: plan.estimatedCredits });
          } catch (e) {
            console.error('[from-url/videos] draft insert failed:', e instanceof Error ? e.message.slice(0, 300) : e);
            failed.push({ name: p.name, error: 'draft_failed', hint: 'The video is rendering and will land in your library, but its post could not be created.' });
          }
          continue;
        }
        fail = r.response;
      } catch (e) {
        fail = planSubmitError(e, 'from-url/videos');
        // Out of credits mid-batch (a render cost more than planned): the rest would fail too.
        stop = e instanceof InsufficientCreditsError;
      }
      firstFailure ??= fail;
      failed.push({ name: p.name, ...(await errorOf(fail)) });
      if (stop) break;
    }
    if (!made.length && firstFailure) return firstFailure;

    // No time is picked for the user: they choose when each post goes out (Compose's per-video Schedule).
    return new Response(JSON.stringify({ drafts: made, failed }), { status: 202, headers: { 'content-type': 'application/json' } });
  }, req);
}

async function errorOf(r: Response): Promise<{ error: string; hint?: string }> {
  const b = (await r.clone().json().catch(() => ({}))) as { error?: string; hint?: string; message?: string };
  return { error: b.error ?? 'video_submit_failed', ...(b.hint || b.message ? { hint: b.hint ?? b.message } : {}) };
}
