import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { isStubMode } from '../../../../lib/env';
import { FOOTAGE_EDIT, MOTION_AI } from '../../../../lib/ai/models';
import { motionAiConfigured } from '../../../../lib/ai/motionAi';
import { submitFootageEdit } from '../../../../lib/media/motionJob';
import { headObject, publicUrlFor } from '../../../../lib/storage/r2';
import { InsufficientCreditsError, insufficientCreditsResponse } from '../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** What the editor does when the box is left empty. */
const DEFAULT_ASK = 'Make it a tight, engaging cut: remove long pauses, filler words and false starts, and keep the best takes.';

const bodySchema = z.object({
  /** R2 keys from /api/media/upload-url, in play order. */
  clips: z.array(z.object({ key: z.string().max(400), name: z.string().trim().max(200).default('') })).min(1).max(FOOTAGE_EDIT.maxClips),
  /** "How should we edit it?" Empty = DEFAULT_ASK. */
  instructions: z.string().trim().max(2_000).default(''),
  aspect: z.enum(MOTION_AI.aspects).default('9:16'),
  /** null = Auto (the editor picks the length). */
  lengthSec: z.number().int().min(MOTION_AI.durationSec.min).max(MOTION_AI.durationSec.max).nullable().default(null),
  /** Total clip length the browser read; only ever lowers the quote (footageEditCap). */
  sourceSec: z.number().positive().max(FOOTAGE_EDIT.maxSourceSec * FOOTAGE_EDIT.maxClips).nullable().optional(),
  music: z.boolean().default(false),
  sfx: z.boolean().default(false),
});

/** A clip key is usable when it is in the caller's prefix and the object really is a video within the limits. */
async function checkClip(userId: string, key: string): Promise<string | null> {
  if (!key.startsWith(`users/${userId}/`) || !/^users\/[A-Za-z0-9._\-/]+$/.test(key) || key.includes('..')) return 'bad_clip';
  const head = await headObject(key);
  if (!head) return 'clip_missing';
  if (head.size === 0) return 'clip_missing'; // an aborted upload can leave an empty object
  if (head.size > FOOTAGE_EDIT.maxBytes) return 'clip_too_large';
  if (!(FOOTAGE_EDIT.mimes as readonly string[]).includes(head.contentType)) return 'clip_unsupported';
  return null;
}

/**
 * POST /api/media/edit-footage → 202 { model, jobs: [{ id, … }] }
 * "Edit my video": cut and finish the user's own clips the way they asked. Charged
 * the quote up front (priceForFootageEdit at footageEditCap); the unused seconds come
 * back when it finishes, everything on failure. Polls via /api/media/video-job/[id]
 * and opens in the motion editor like any AI-designed video.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (!motionAiConfigured()) return jsonError('not_found', 404);
    if (isStubMode.r2()) return jsonError('r2_not_configured', 503);
    const rl = rateLimit('agentRun', `vidgen:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });

    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const { clips, instructions, aspect, lengthSec, sourceSec, music, sfx } = parsed.data;

    for (const c of clips) {
      const bad = await checkClip(user.id, c.key);
      if (bad) return jsonError(bad, 400, { hint: 'One of the clips didn’t upload properly. Remove it and add it again. Nothing was charged.' });
    }

    try {
      const { job, creditsCharged } = await submitFootageEdit({
        userId: user.id, aspect, lengthSec, sourceSec, music, sfx,
        instructions: instructions || DEFAULT_ASK,
        clips: clips.map((c) => ({ url: publicUrlFor(c.key), name: c.name })),
      });
      return new Response(
        JSON.stringify({
          model: 'Edit my video',
          jobs: [{ id: job.id, status: job.status, durationSec: job.durationSec, aspect: job.aspect, creditsCharged }],
          creditsChargedTotal: creditsCharged,
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    } catch (e) {
      if (e instanceof InsufficientCreditsError) return insufficientCreditsResponse({ balance: e.balance, needed: e.needed });
      // White-label: engine detail goes to the log only. Any charge was refunded in submitFootageEdit.
      console.error('[edit-footage] submit failed:', e instanceof Error ? e.message.slice(0, 400) : e);
      return jsonError('video_submit_failed', 502);
    }
  }, req);
}
