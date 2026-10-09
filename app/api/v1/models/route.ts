import { NextRequest } from 'next/server';
import { withApiKey } from '../../../../lib/api-key';
import { isStubMode } from '../../../../lib/env';
import { priceForChat, priceForVideo } from '../../../../lib/credits/pricing';
import { priceCinemaRender } from '../../../../lib/ai/cue';
import {
  CHAT_LIMITS,
  CHAT_MODEL_IDS,
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODELS,
  VIDEO_MODEL_IDS,
  type VideoModelId,
} from '../../../../lib/ai/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/models — what `model` on POST /api/v1/videos (type `video`) and
 * POST /api/v1/chat/completions (type `chat`) accept.
 *
 * Built from lib/ai/models.ts, the same table the request validator rejects
 * against, so this cannot drift from what the endpoint actually allows. A
 * client that reads this and stays inside the envelope it describes never sees
 * a 400 for an unsupported combination.
 *
 * `available: false` means the model is configured out right now — a submit
 * would answer 503 without charging. Callers should fall back rather than
 * retry.
 *
 * No provider is named here, ever. That is the point of the file.
 */
export async function GET(req: NextRequest) {
  return withApiKey(req, async () => {
    const models = await Promise.all(
      VIDEO_MODEL_IDS.map(async (id) => {
        const m = VIDEO_MODELS[id];
        return {
          id: m.id,
          type: 'video' as const,
          name: m.name,
          summary: m.summary,
          default: id === DEFAULT_VIDEO_MODEL,
          available: availability(id),
          capabilities: {
            duration_sec: m.durationSec,
            quality: m.qualities,
            aspect: m.aspects,
            gen_mode: m.genModes,
            native_audio: m.nativeAudio,
            fast_tier: m.supportsFast,
            end_frame_alone: m.endFrameAlone,
            match_frame_aspect: m.matchFrameAspect,
          },
          // Indicative, not a quote: one representative render so a caller can
          // compare models without submitting. Omitted rather than guessed when
          // it can't be priced — a wrong number here is worse than no number.
          example: await examplePrice(id),
        };
      }),
    );

    // Appended AFTER the video models, so a client that takes the first
    // `default: true` entry still gets the default video model. `default` is
    // per type.
    const chat = CHAT_MODEL_IDS.map((id) => ({
      id,
      type: 'chat' as const,
      name: CHAT_MODELS[id].name,
      summary: CHAT_MODELS[id].summary,
      default: id === DEFAULT_CHAT_MODEL,
      available: !!process.env.OPENAI_API_KEY,
      capabilities: {
        input: ['text', 'image'],
        output: ['text', 'json'],
        max_output_tokens: CHAT_LIMITS.maxOutputTokens,
        max_images: CHAT_LIMITS.maxImages,
        streaming: false,
      },
      // Metered per call from actual usage; one representative caption call.
      example: { prompt_tokens: 1500, completion_tokens: 500, credits: priceForChat(CHAT_MODELS[id].tier, 1500, 500).credits },
    }));

    return Response.json({ models: [...models, ...chat] });
  });
}

function availability(id: VideoModelId): boolean {
  if (isStubMode.r2()) return false;
  return id === 'sociafy-cinema-1' ? !isStubMode.cue() : !!process.env.PIAPI_API_KEY;
}

async function examplePrice(id: VideoModelId) {
  const durationSec = 8;
  const quality = '720p' as const;
  try {
    const credits =
      id === 'sociafy-cinema-1'
        ? (await priceCinemaRender({ durationSec, quality })).credits
        : priceForVideo({ durationSec, quality, fast: false }).credits;
    return { duration_sec: durationSec, quality, credits };
  } catch (e) {
    console.warn('[v1/models] could not price', id, e instanceof Error ? e.message : e);
    return null;
  }
}
