/**
 * The public model catalogue — Sociafy's own names for the engines behind
 * video generation, and the only place a public id maps to a backend.
 *
 * This file exists to be the one seam. Everything customer-facing (the /v1
 * API, the docs page, the studio) speaks `sociafy-*` ids; everything below it
 * speaks provider ids. A vendor name must never cross this line in either
 * direction: not in a model id, not in an error string, not in a capability
 * label. Swapping the engine under a model then costs one line here instead of
 * a migration and an apology to every integrator.
 *
 * `videoJobs.provider` stores the BACKEND id (it is operational, and the /v1
 * responses never include it). `videoJobs.meta`-equivalents and API responses
 * carry the PUBLIC id.
 */

import type { VideoQuality } from '../credits/pricing';

/** Internal backend identifiers. Persisted to videoJobs.provider. Never public.
 *  'piapi-seedance-2' is no longer written (Motion quality moved to 2.5) but
 *  stays here because existing rows carry it. */
export type VideoBackend = 'piapi-seedance-2.5' | 'piapi-seedance-2' | 'piapi-seedance-2-fast' | 'cue-h3' | 'motion-hf' | 'motion-claude';

export const VIDEO_MODEL_IDS = ['sociafy-motion-1', 'sociafy-cinema-1'] as const;
export type VideoModelId = (typeof VIDEO_MODEL_IDS)[number];

/** What a NEW generation renders on when the caller does not choose. */
export const DEFAULT_VIDEO_MODEL: VideoModelId = 'sociafy-motion-1';

/** What an OLD row is. Every backend id that predates the catalogue is Motion,
 *  and that is a fact about history — it must not follow the default above, or
 *  flipping the default would relabel every existing Motion render. */
const LEGACY_VIDEO_MODEL: VideoModelId = 'sociafy-motion-1';

/** Public API default. Pinned to Motion so integrators who omit `model` keep
 *  the behaviour (1080p, reference mode) they built against. */
export const API_DEFAULT_VIDEO_MODEL: VideoModelId = LEGACY_VIDEO_MODEL;

export type VideoModel = {
  id: VideoModelId;
  name: string;
  /** One line, customer-facing. Says what it is FOR, not what it runs on. */
  summary: string;
  /** Inclusive seconds. */
  durationSec: { min: number; max: number };
  qualities: VideoQuality[];
  aspects: readonly ('9:16' | '1:1' | '16:9')[];
  genModes: readonly ('text' | 'reference' | 'image-to-video')[];
  /** True when the model scores its own soundtrack rather than rendering mute. */
  nativeAudio: boolean;
  /** True when `fast` changes anything. */
  supportsFast: boolean;
  /** Longest clip the fast tier renders, or null when there is no fast tier.
   *  A longer `fast` request renders on quality, like 1080p does — and is
   *  billed the same either way (priceForVideo has no fast tier past 12 s). */
  fastMaxSec: number | null;
  /**
   * True when the model can render from a CLOSING frame alone, with no
   * start_frame — "end here, work out how to arrive."
   *
   * False is not a style choice: Motion's backend takes its frames as an
   * ordered [start, end?] list, so the first slot IS the opening frame and
   * there is no way to fill only the second.
   */
  endFrameAlone: boolean;
  /**
   * True when the model can take its canvas SHAPE from the supplied frame
   * instead of from `aspect` — so a portrait still is not rendered into a
   * landscape box and letterboxed.
   *
   * Shape only. The canvas AREA still comes from `quality`, so this does not
   * move the price.
   */
  matchFrameAspect: boolean;
};

const ASPECTS = ['9:16', '1:1', '16:9'] as const;

export const VIDEO_MODELS: Record<VideoModelId, VideoModel> = {
  'sociafy-motion-1': {
    id: 'sociafy-motion-1',
    name: 'Sociafy Motion 1',
    summary:
      'General-purpose social video up to 30s. Takes product stills as references and can open and close on frames you supply. Renders without sound.',
    // PiAPI: Seedance 2.5 takes any integer 4-30 s; 2.0 Fast only 4-15 s
    // (piapi.ai/docs/seedance-api/seedance-25 and .../seedance-2).
    durationSec: { min: 4, max: 30 },
    qualities: ['480p', '720p', '1080p'],
    aspects: ASPECTS,
    genModes: ['text', 'reference', 'image-to-video'],
    nativeAudio: false,
    supportsFast: true,
    fastMaxSec: 15,
    endFrameAlone: false,
    matchFrameAspect: false,
  },
  'sociafy-cinema-1': {
    id: 'sociafy-cinema-1',
    name: 'Sociafy Cinema 1',
    summary:
      'Longer, sound-on video up to 30s. Scores its own audio from the prompt — end the prompt with an "Audio:" line to direct it. Can open and close on frames you supply. 1080p is not offered.',
    durationSec: { min: 4, max: 30 },
    // 0.98 MP (1344x768) is the ceiling this engine renders at — above 720p's
    // 0.92 MP, below 1080p's 2.07. Offering "1080p" here would be a lie.
    qualities: ['480p', '720p'],
    aspects: ASPECTS,
    // 'reference' is still withheld, and only that one. It maps to the
    // backend's ref_images, which switches the render into a different mode
    // (ref2v) whose price we have not measured — and Cinema is charged from a
    // live quote, so an unmeasured mode is an unpriced one. Frames do not
    // change the mode, so they are safe to offer.
    genModes: ['text', 'image-to-video'],
    nativeAudio: true,
    supportsFast: false,
    fastMaxSec: null,
    // Verified against the backend: a render with last_frame and no first_frame
    // is accepted and completes (mode i2v, has_first false, has_last true).
    endFrameAlone: true,
    matchFrameAspect: true,
  },
};

/**
 * Brand-kit motion graphics. Deliberately NOT in VIDEO_MODELS: it renders a
 * fixed template from the brand kit + a topic rather than a prompt, so it has
 * no place on /v1's model envelope. Only offered when MOTION_ENGINE_URL is set.
 */
export const MOTION_GRAPHICS = { backend: 'motion-hf', name: 'Sociafy Motion Graphics' } as const satisfies {
  backend: VideoBackend;
  name: string;
};

/**
 * AI-designed motion graphics: a one-off motion graphic authored from the post
 * text + brand kit on a GPU worker (lib/ai/motionAi.ts), not a fixed template.
 * Same reasoning as MOTION_GRAPHICS for staying out of VIDEO_MODELS. Rows carry
 * provider 'motion-claude' — internal only; the public name is all that leaves.
 * Only offered when MOTION_AI_URL + MOTION_AI_SECRET are set.
 */
export const MOTION_AI = {
  backend: 'motion-claude',
  name: 'AI-designed motion graphic',
  durationSec: { min: 6, max: 60, default: 15 },
  aspects: ['9:16', '16:9', '1:1'],
} as const satisfies { backend: VideoBackend; name: string; durationSec: { min: number; max: number; default: number }; aspects: readonly string[] };

/**
 * Extra minutes an AI-designed job longer than 20 s may take: the worker grows
 * its own limits with length (motion-ai/lib.mjs jobLimits, +19 min at 60 s) and
 * browser poll windows and wait copy add this much so they never give up first.
 */
export const motionAiExtraMin = (durationSec = 0) => Math.ceil(Math.max(0, durationSec - 20) / 2);

/** Templates and their fixed lengths (motion/README.md). 9:16 and 16:9 only. */
export const MOTION_TEMPLATES = {
  stat: { label: 'Stat', durationSec: 15 },
  showcase: { label: 'Showcase', durationSec: 16 },
  sting: { label: 'Logo sting', durationSec: 7 },
} as const;
export type MotionTemplate = keyof typeof MOTION_TEMPLATES;
export const MOTION_TEMPLATE_IDS = Object.keys(MOTION_TEMPLATES) as MotionTemplate[];
export const MOTION_ASPECTS = ['9:16', '16:9'] as const;

/** Which backend serves a public model id at these settings. */
export function backendFor(model: VideoModelId, fast: boolean): VideoBackend {
  if (model === 'sociafy-cinema-1') return 'cue-h3';
  return fast ? 'piapi-seedance-2-fast' : 'piapi-seedance-2.5';
}

/** Public model id for a stored backend id. Legacy rows predate the catalogue
 *  and are all Motion, so an unknown backend answers Motion rather than
 *  leaking the raw column into a response. */
export function modelForBackend(backend: string | null | undefined): VideoModelId {
  return backend === 'cue-h3' ? 'sociafy-cinema-1' : LEGACY_VIDEO_MODEL;
}

export function isVideoModelId(v: unknown): v is VideoModelId {
  return typeof v === 'string' && (VIDEO_MODEL_IDS as readonly string[]).includes(v);
}

/**
 * Check a request against a model's published envelope.
 *
 * Returns a field + message rather than a boolean so the route can answer a
 * 400 that names what to change. Deliberately rejects instead of clamping: a
 * silently downgraded render is one the caller pays full attention to and did
 * not ask for, and they find out from the file, not from us.
 */
export function validateAgainstModel(
  model: VideoModelId,
  req: { durationSec: number; quality: VideoQuality; aspect: string; genMode: string; fast: boolean },
): { field: string; message: string } | null {
  const m = VIDEO_MODELS[model];
  if (req.durationSec < m.durationSec.min || req.durationSec > m.durationSec.max) {
    return {
      field: 'duration_sec',
      message: `${m.name} renders ${m.durationSec.min}-${m.durationSec.max}s.`,
    };
  }
  if (!m.qualities.includes(req.quality)) {
    return { field: 'quality', message: `${m.name} supports ${m.qualities.join(', ')}.` };
  }
  if (!(m.aspects as readonly string[]).includes(req.aspect)) {
    return { field: 'aspect', message: `${m.name} supports ${m.aspects.join(', ')}.` };
  }
  if (!(m.genModes as readonly string[]).includes(req.genMode)) {
    return { field: 'gen_mode', message: `${m.name} supports gen_mode ${m.genModes.join(', ')}.` };
  }
  // Not an error — `fast` is a hint, and a model with one speed simply has one
  // speed. Charging differently would be the problem, and pricing reads the
  // model, not this flag.
  return null;
}

// =====================================================
// Chat / vision models (POST /api/v1/chat/completions)
// =====================================================

/**
 * Public chat ids → the MODELS tier (lib/ai/client.ts) that serves them. Both
 * tiers default to vision-capable models. The tier, not the provider model
 * name, is what pricing reads (priceForChat), so an env override of the model
 * must be matched by a CHAT_USD_PER_MTOK update.
 */
export const CHAT_MODELS = {
  'sociafy-chat-1': {
    tier: 'smart',
    name: 'Sociafy Chat 1',
    summary: 'Best writing quality. Text and image input, text or JSON output.',
  },
  'sociafy-chat-1-mini': {
    tier: 'fast',
    name: 'Sociafy Chat 1 Mini',
    summary: 'Faster and cheaper for short, simple tasks. Text and image input.',
  },
} as const satisfies Record<string, { tier: 'smart' | 'fast'; name: string; summary: string }>;

export type ChatModelId = keyof typeof CHAT_MODELS;
export const CHAT_MODEL_IDS = Object.keys(CHAT_MODELS) as ChatModelId[];
export const DEFAULT_CHAT_MODEL: ChatModelId = 'sociafy-chat-1';

/** Request limits for /chat/completions. Here, not in the route, so GET
 *  /api/v1/models reports the same numbers the validator enforces. */
export const CHAT_LIMITS = {
  /** Images per request. The real bound is bytes (below); this keeps latency sane. */
  maxImages: 4,
  /** Raw bytes across all images. base64 inflates by 4/3, so ~27 MB goes upstream,
   *  under the provider's 50 MB request cap. */
  maxTotalImageBytes: 20 * 1024 * 1024,
  maxMessages: 100,
  /** All text across all messages. */
  maxTextChars: 200_000,
  /** Output cap, reasoning included. Bounds the worst case one call can bill. */
  maxOutputTokens: 8_192,
  defaultOutputTokens: 4_096,
  /** Pre-flight only: an upper bound on one image's input tokens at high detail. */
  worstCaseImageTokens: 2_500,
} as const;
