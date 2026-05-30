import { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { db } from '../../../../lib/db';
import { voices, genJobs } from '../../../../lib/db/schema';
import { submitAvatar, modalConfigured } from '../../../../lib/ai/modal';
import { priceForAvatar } from '../../../../lib/credits/pricing';
import { ensureBalance, charge, insufficientCreditsResponse } from '../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const schema = z
  .object({
    imageUrl: z.string().url().max(2_000),
    voiceId: z.string().uuid().optional(),
    audioUrl: z.string().url().max(2_000).optional(),
    script: z.string().max(2_000).optional(),
    prompt: z.string().max(2_000).optional(),
    aspect: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
    quality: z.enum(['480p', '720p']).default('720p'),
    expressive: z.boolean().default(false),
  })
  .refine((d) => (d.voiceId && d.script) || d.audioUrl, {
    message: 'need either (voiceId + script) or audioUrl',
  });

/**
 * POST /api/media/generate-avatar — submit a talking-avatar job.
 *
 * Two drive modes: a Voice Twin + script (the engine synthesizes speech in the
 * cloned voice as the first step of one pipeline), or a ready audio track. The
 * job is recorded in gen_jobs and polled via /api/media/gen-job/[id].
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('avatarGen', `avatar:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });

    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(schema, raw);
    if (!parsed.ok) return parsed.response;
    const d = parsed.data;

    let voice: { refAudioUrl: string; refText: string } | undefined;
    if (d.voiceId) {
      const [v] = await db()
        .select()
        .from(voices)
        .where(and(eq(voices.id, d.voiceId), eq(voices.userId, user.id)))
        .limit(1);
      if (!v || v.status !== 'ready') return jsonError('voice_not_ready', 400);
      voice = { refAudioUrl: v.refPublicUrl, refText: v.transcript ?? '' };
    }

    const price = priceForAvatar(d.quality);
    const pre = await ensureBalance(user.id, price.credits);
    if (!pre.ok) return insufficientCreditsResponse({ balance: pre.balance, needed: pre.needed });

    // STUB MODE: record a pending job; gen-job poller finalizes a placeholder.
    if (!modalConfigured('avatar')) {
      const [job] = await db()
        .insert(genJobs)
        .values({
          userId: user.id,
          kind: 'avatar',
          provider: 'modal-avatar',
          providerCallId: `stub-av-${Date.now()}`,
          status: 'pending',
          inputJson: d as Record<string, unknown>,
        })
        .returning();
      return { job: { id: job.id, status: 'pending' }, stub: true };
    }

    const { callId } = await submitAvatar({
      imageUrl: d.imageUrl,
      prompt: d.prompt,
      aspect: d.aspect,
      quality: d.quality,
      expressive: d.expressive,
      ...(voice && d.script ? { voice, script: d.script } : {}),
      ...(d.audioUrl ? { audioUrl: d.audioUrl } : {}),
    });
    const charged = await charge({ userId: user.id, action: price.action, credits: price.credits, meta: { quality: d.quality } });
    const [job] = await db()
      .insert(genJobs)
      .values({
        userId: user.id,
        kind: 'avatar',
        provider: 'modal-avatar',
        providerCallId: callId,
        status: 'pending',
        inputJson: d as Record<string, unknown>,
        creditLedgerId: charged.ledgerId,
        creditsCharged: price.credits,
      })
      .returning();
    return { job: { id: job.id, status: 'pending' } };
  }, req);
}
