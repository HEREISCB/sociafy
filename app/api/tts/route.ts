import { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { parseBody } from '../../../lib/validation';
import { rateLimit } from '../../../lib/rate-limit';
import { db } from '../../../lib/db';
import { voices, genJobs } from '../../../lib/db/schema';
import { submitTts, modalConfigured } from '../../../lib/ai/modal';
import { creditsFor } from '../../../lib/credits/pricing';
import { ensureBalance, charge, insufficientCreditsResponse } from '../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const schema = z.object({
  voiceId: z.string().uuid(),
  text: z.string().min(1).max(2_000),
});

/**
 * POST /api/tts — synthesize speech in a Voice Twin. Returns a gen_jobs id the
 * client polls via /api/media/gen-job/[id]. Used by Voice Studio previews and
 * standalone text-to-speech.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('tts', `tts:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });

    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(schema, raw);
    if (!parsed.ok) return parsed.response;
    const { voiceId, text } = parsed.data;

    const [voice] = await db()
      .select()
      .from(voices)
      .where(and(eq(voices.id, voiceId), eq(voices.userId, user.id)))
      .limit(1);
    if (!voice || voice.status !== 'ready') return jsonError('voice_not_ready', 400);

    const credits = creditsFor('tts_synthesis');
    const pre = await ensureBalance(user.id, credits);
    if (!pre.ok) return insufficientCreditsResponse({ balance: pre.balance, needed: pre.needed });

    // STUB MODE: record a pending job with a stub call id; the gen-job poller
    // finalizes it to a placeholder asset.
    if (!modalConfigured('voice')) {
      const [job] = await db()
        .insert(genJobs)
        .values({
          userId: user.id,
          kind: 'tts',
          provider: 'modal-voice',
          providerCallId: `stub-tts-${Date.now()}`,
          status: 'pending',
          inputJson: { voiceId, text },
        })
        .returning();
      return { job: { id: job.id, status: 'pending' }, stub: true };
    }

    const { callId } = await submitTts({
      refAudioUrl: voice.refPublicUrl,
      refText: voice.transcript ?? '',
      text,
    });
    const charged = await charge({ userId: user.id, action: 'tts_synthesis', credits, meta: { voiceId } });
    const [job] = await db()
      .insert(genJobs)
      .values({
        userId: user.id,
        kind: 'tts',
        provider: 'modal-voice',
        providerCallId: callId,
        status: 'pending',
        inputJson: { voiceId, text },
        creditLedgerId: charged.ledgerId,
        creditsCharged: credits,
      })
      .returning();
    return { job: { id: job.id, status: 'pending' } };
  }, req);
}
