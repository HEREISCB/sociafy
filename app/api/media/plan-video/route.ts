import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { planVideo } from '../../../../lib/ai/videoBrain';
import { attachmentSchema, brainContext } from '../../../../lib/media/autoVideo';

export const runtime = 'nodejs';
export const maxDuration = 60;

const aspect = z.enum(['9:16', '1:1', '16:9']);

const bodySchema = z.object({
  text: z.string().trim().min(2).max(4_000),
  platforms: z.array(z.string().trim().max(20)).max(10).default([]),
  attachments: z.array(attachmentSchema).max(9).default([]),
  overrides: z.object({
    format: z.enum(['ai_video', 'motion_graphic', 'hybrid']).optional(),
    durationSec: z.number().int().min(4).max(30).optional(),
    aspect: aspect.optional(),
  }).strict().optional(),
});

/**
 * POST /api/media/plan-video → 200 { plan, estimatedCredits, summary, reasons, alternatives, balance }
 * The video brain (lib/ai/videoBrain.ts): which format suits this post, and what
 * it costs. No charge. Generate with POST /api/media/generate-auto.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('videoPlan', `vidplan:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const { text, platforms, attachments, overrides } = parsed.data;

    const { availability, balance } = await brainContext(user.id);
    const result = await planVideo({ text, platforms: platforms.map((p) => p.toLowerCase()), attachments, overrides, availability, balance });
    return { ...result, balance };
  }, req);
}
