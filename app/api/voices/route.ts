import { NextRequest } from 'next/server';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { parseBody } from '../../../lib/validation';
import { rateLimit } from '../../../lib/rate-limit';
import { db } from '../../../lib/db';
import { voices } from '../../../lib/db/schema';
import { validateConsent, VOICE_CONSENT_VERSION } from '../../../lib/legal/voiceConsent';
import { prepareVoice, modalConfigured } from '../../../lib/ai/modal';
import { creditsFor } from '../../../lib/credits/pricing';
import { charge } from '../../../lib/credits/ledger';
import { keyFromPublicUrl } from '../../../lib/storage/r2';

export const runtime = 'nodejs';
export const maxDuration = 60;

const createSchema = z.object({
  name: z.string().min(1).max(60),
  refAudioUrl: z.string().url().max(2_000),
  consentSignature: z.string().min(1).max(120),
});

/** GET /api/voices — the caller's Voice Twins, newest first. */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const rows = await db()
      .select()
      .from(voices)
      .where(eq(voices.userId, user.id))
      .orderBy(desc(voices.createdAt));
    return { voices: rows };
  }, req);
}

/**
 * POST /api/voices — create a Voice Twin.
 *
 * The client first uploads a clean reference clip via /api/media/upload, then
 * posts its URL here with a name + a typed consent signature. We re-validate
 * consent server-side (never trust the client), transcribe + validate the clip
 * on the voice engine, store the profile, and charge the one-time fee.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('voiceCreate', `voice:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });

    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(createSchema, raw);
    if (!parsed.ok) return parsed.response;
    const { name, refAudioUrl, consentSignature } = parsed.data;

    const consent = validateConsent({ version: VOICE_CONSENT_VERSION, signature: consentSignature });
    if (!consent.ok) return jsonError('consent_invalid', 400, { reason: consent.reason });

    // STUB MODE: no voice engine → create a ready voice with a placeholder
    // transcript so the whole flow runs locally without a GPU.
    if (!modalConfigured('voice')) {
      const [row] = await db()
        .insert(voices)
        .values({
          userId: user.id,
          name,
          status: 'ready',
          refStorageKey: keyFromPublicUrl(refAudioUrl),
          refPublicUrl: refAudioUrl,
          refDurationS: '20',
          transcript: '(stub transcript)',
          language: 'en',
          consentVersion: VOICE_CONSENT_VERSION,
          consentSignature,
          consentAcceptedAt: new Date(),
        })
        .returning();
      return { voice: row, stub: true };
    }

    const prep = await prepareVoice({ refAudioUrl });
    if (!prep.ok) return jsonError('voice_prepare_failed', 422, { reason: prep.error });

    const credits = creditsFor('voice_twin_create');
    const charged = await charge({ userId: user.id, action: 'voice_twin_create', credits, meta: { name } });

    const [row] = await db()
      .insert(voices)
      .values({
        userId: user.id,
        name,
        status: 'ready',
        refStorageKey: keyFromPublicUrl(refAudioUrl),
        refPublicUrl: refAudioUrl,
        refDurationS: prep.durationS != null ? String(prep.durationS) : null,
        transcript: prep.transcript ?? null,
        language: prep.language ?? null,
        consentVersion: VOICE_CONSENT_VERSION,
        consentSignature,
        consentAcceptedAt: new Date(),
      })
      .returning();
    return { voice: row, ledgerId: charged.ledgerId };
  }, req);
}
