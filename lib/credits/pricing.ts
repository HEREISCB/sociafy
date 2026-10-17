/**
 * Per-action credit cost table. Source of truth for what every billable
 * surface charges. Numbers come straight from docs/pricing.md §3.2 — keep
 * them in sync.
 *
 * Convention: callers pass shape descriptors (size, quality, resolution),
 * and `priceFor*` functions map them to credits + a stable action key. The
 * action key lands in the ledger so we can build usage analytics later
 * without re-deriving cost from raw shape fields.
 */

import type { Platform } from '../db/schema';
import { MOTION_AI } from '../ai/models';

/** Stable action keys persisted to credit_ledger.action. */
export type CreditAction =
  | 'text_post'
  | 'text_post_research'
  | 'web_search_extra'
  | 'image_low_1024'
  | 'image_medium_1024'
  | 'image_medium_portrait'
  | 'image_high_1024'
  | 'image_high_portrait'
  | 'image_reference'
  | 'video_8s_480p_fast'
  | 'video_8s_480p_quality'
  | 'video_8s_720p_fast'
  | 'video_8s_720p_quality'
  | 'video_8s_1080p_quality'
  | 'video_15s_480p_quality'
  | 'video_15s_720p_quality'
  | 'video_15s_1080p_quality'
  | 'variant_regenerate'
  | 'agent_draft'
  | 'publish_x'
  | 'voice_twin_create'
  | 'tts_synthesis'
  | 'avatar_video_480p'
  | 'avatar_video_720p'
  | 'video_cinema'
  | 'video_motion_graphics'
  | 'video_motion_ai'
  | 'text_chat';

/** Single source-of-truth credit cost per action. */
export const CREDIT_PRICES: Record<CreditAction, number> = {
  text_post: 1,
  text_post_research: 6,
  web_search_extra: 5,
  // Image = gpt-image-2 (env OPENAI_IMAGE_MODEL). NOTE: on gpt-image-2 the
  // SQUARE tiers cost MORE than portrait/landscape (med sq $0.053 vs $0.041;
  // high sq $0.211 vs $0.165), inverting the gpt-image-1 scale. Priced to stay
  // profitable at the Business rate ($0.012/credit). Costs incl. ~$0.005 rewriter.
  image_low_1024: 2,                  // ~$0.011 → 2cr=$0.024 @business (~54%)
  image_medium_1024: 6,               // square med ~$0.058 → 6cr=$0.072 (~24%)
  image_medium_portrait: 6,           // portrait/landscape med ~$0.046 → $0.072 (~57%)
  image_high_1024: 24,                // square high ~$0.216 → 24cr=$0.288 (~33%)
  image_high_portrait: 23,            // portrait/landscape high ~$0.170 → $0.276 (~62%)
  // Reference-image input (images.edit), charged FLAT per reference image — not
  // per megapixel. Input image tokens are patch-based and clamped, measured on the
  // live API at size=1024x1024/quality=low with one reference each:
  //   512²  (0.25 MP) → 1024 tok    2048² (4 MP)  → 1521 tok
  //   1024² (1.05 MP) → 1024 tok    4000² (16 MP) → 1521 tok
  // i.e. a floor of 1024 (32²) and a ceiling of 1521 (39²): OpenAI downscales
  // internally, so a 16 MP source costs us exactly what a 4 MP one does. Pixels
  // therefore have no cost basis at all — pricing by them overcharged a 4000²
  // catalogue photo 64 cr for a bill bounded at 1,521 tokens.
  // OpenAI does not publish a gpt-image-2 *input* image token rate anywhere we
  // can cite, so assume $20/1M — deliberately 2× the published gpt-image-1
  // image-input rate ($10/1M). Worst case 1,521 tok = $0.0304 per reference;
  // 6 cr = $0.072 at the Business rate ($0.012/credit) → ~58% margin, and still
  // ~15% if the real rate is double again ($40/1M → $0.0608). Break-even ≈ $47/1M.
  image_reference: 6,
  // Motion. Fast = Seedance 2.0 Fast; Quality = Seedance 2.5 ($0.15 / $0.35 /
  // $0.80 per s at 480p / 720p / 1080p, piapi.ai/docs/seedance-api/seedance-25).
  // Quality = ceil(provider $ × CREDITS_PER_PROVIDER_USD), e.g. 8s 720p $2.80 → 315.
  video_8s_480p_fast: 75,
  video_8s_480p_quality: 135,
  video_8s_720p_fast: 145,
  video_8s_720p_quality: 315,
  video_8s_1080p_quality: 720,
  video_15s_480p_quality: 254,
  video_15s_720p_quality: 591,
  video_15s_1080p_quality: 1350,
  variant_regenerate: 1,
  // Autopilot draft = gpt-5 + web_search per run (~$0.042), up to 2 drafts/run.
  // Worst case (1 research-backed draft) needs ≥4 cr to stay profitable at the
  // Business floor ($0.012/cr → $0.048 vs $0.042); 2-draft runs net ~56% margin.
  agent_draft: 4,
  publish_x: 0,                       // X cost is amortized in subscription
  // Voice/avatar run on Modal GPUs (L4 $0.000222/s, L40S $0.000542/s). Cost is
  // dominated by container load + scaledown idle, so we price off measured
  // worst-case (isolated, cold) cost on the same $0.009 cost-basis as every
  // other action. Verified profitable at the Business rate ($0.012/credit).
  voice_twin_create: 10,              // L4 prepare (transcribe+validate) ~$0.05; one-time, also deters throwaway clones
  tts_synthesis: 8,                   // L4 clone-TTS render ~$0.05 → 8 cr ≈ $0.096 @business (~48% margin)
  avatar_video_480p: 50,              // L40S+L4 ~$0.30 → 50 cr ≈ $0.60 @business (~50% margin)
  avatar_video_720p: 90,              // L40S+L4 ~$0.50 → 90 cr ≈ $1.08 @business (~54% margin)
  // Sociafy Cinema: the only VARIABLE-priced action in this table. Cost is
  // neither linear in duration nor in area, so the number here is a nominal
  // 8s/720p reference and the real figure comes from priceForCinemaVideo(),
  // which quotes the backend per request. `charge()` takes credits as an
  // argument, not from this table, so the two never disagree on the bill.
  video_cinema: 33,
  // Sociafy Motion Graphics: brand-kit templates rendered headless on a CPU
  // container (2 cores, ~2 GiB). Worst case incl. cold start + idle tail ≈ 200
  // billed seconds ≈ $0.006, plus ~$0.002 for the copy-writing call. Priced
  // per started 8s of output (see priceForMotion): 5 cr for a 7s sting, 10 cr
  // for a 15–16s stat/showcase → $0.06–0.12 @business, >85% margin, and still
  // an order of magnitude under a generated clip.
  video_motion_graphics: 5,
  // AI-designed motion graphics: a model authors the composition on a GPU box
  // (several minutes of agent + render compute per job, retries included),
  // then renders it. Priced PER SECOND of output (see priceForMotionAi): 12 cr
  // for 6s, 30 cr for 15s, 40 cr for 20s. The authoring compute, not the
  // render, is most of the cost — owner to confirm the rate.
  video_motion_ai: 2,
  // POST /api/v1/chat/completions. Metered per call from the provider's actual
  // token usage by priceForChat() below; this number is only the per-call floor.
  text_chat: 1,
};

export function creditsFor(action: CreditAction): number {
  return CREDIT_PRICES[action];
}

// =====================================================
// Image-gen price helper
// =====================================================
/** `WxH` in pixels. Was a three-value union; the provider accepts far more than
 *  that (see lib/ai/image-sizes.ts), and the route validates the string against
 *  those bounds before it ever reaches pricing. */
export type ImageSize = string;
export type ImageQuality = 'low' | 'medium' | 'high';

/**
 * `referenceCount` prices reference-image input (images.edit): the provider bills
 * input image tokens on top of the output price, bounded per reference regardless
 * of its resolution — see image_reference above. Omit it (or pass 0) and the
 * result is byte-identical to before, so text-only generation is untouched.
 */
export function priceForImage(
  size: ImageSize,
  quality: ImageQuality,
  referenceCount?: number,
): { action: CreditAction; credits: number; surcharge: number } {
  // The two original non-square sizes keep the price they have always had, so
  // no working integration moves. EVERYTHING else — presets and custom sizes
  // alike — is billed at the square tier, which is the dearer of the two.
  //
  // Not cosmetic: provider cost tracks the SHORT edge, not the pixel count, and
  // the new shapes land between the two tiers. Instagram's 4:5 measures 181
  // output tokens against the 158 the non-square tier is priced off and the 196
  // of a square — so billing it as non-square would under-charge. Every size
  // lib/ai/image-sizes.ts admits is measured at or under that 196, which makes
  // the square tier a ceiling we are always at or above.
  const isSquare = size !== '1536x1024' && size !== '1024x1536';
  let action: CreditAction;
  if (quality === 'low') {
    // gpt-image-2 low pricing is flat across aspect — both stay at 2 credits.
    action = 'image_low_1024';
  } else if (quality === 'medium') {
    action = isSquare ? 'image_medium_1024' : 'image_medium_portrait';
  } else {
    action = isSquare ? 'image_high_1024' : 'image_high_portrait';
  }
  // Flat per reference: each one is its own bounded block of input tokens, and
  // its dimensions change neither that bound nor the bill. floor() because a
  // fractional count is a caller bug, not a half-charge.
  const refs = Math.max(0, Math.floor(referenceCount ?? 0));
  const surcharge = refs * CREDIT_PRICES.image_reference;
  return { action, credits: CREDIT_PRICES[action] + surcharge, surcharge };
}

// =====================================================
// Video-gen price helper
// =====================================================
export type VideoQuality = '480p' | '720p' | '1080p';

/**
 * Maps (duration, quality, fast) to a credit price.
 *
 * We bucket durations into 8s and 15s tiers (matches the pricing doc). For
 * other durations we proportionally scale from the 8s tier — keeps the math
 * consistent without exploding the action enum.
 *
 * `inputDurationSec` prices Seedance's video-to-video surcharge (COSTS.md:77):
 * feeding a reference clip costs (unit_price / 2) × input_duration on top of
 * the output price. Omit it (or pass 0) and the result is byte-identical to
 * before — non-reference generations are untouched.
 */
export function priceForVideo(args: {
  durationSec: number;
  quality: VideoQuality;
  fast: boolean;
  /** Length of a reference/video-to-video input clip, in seconds. */
  inputDurationSec?: number;
}): { action: CreditAction; credits: number; surcharge: number } {
  const { durationSec, quality, fast } = args;
  const is15 = durationSec >= 13;
  // 1080p Fast is not offered by Seedance — fall back to Quality (piapi.ts
  // seedanceTaskType routes the render the same way).
  const useFast = fast && quality !== '1080p';

  let action: CreditAction;
  if (is15) {
    if (quality === '480p') action = 'video_15s_480p_quality';
    else if (quality === '720p') action = 'video_15s_720p_quality';
    else action = 'video_15s_1080p_quality';
  } else if (quality === '480p') {
    action = useFast ? 'video_8s_480p_fast' : 'video_8s_480p_quality';
  } else if (quality === '720p') {
    action = useFast ? 'video_8s_720p_fast' : 'video_8s_720p_quality';
  } else {
    action = 'video_8s_1080p_quality';
  }

  // For durations between buckets, scale linearly off the 8s base.
  // (e.g. 6s 720p Quality = 315 * 6/8 = 236.)
  const baseCredits = CREDIT_PRICES[action];
  let credits = baseCredits;
  if (!is15 && durationSec !== 8) {
    credits = Math.round((baseCredits * durationSec) / 8);
  } else if (is15 && durationSec !== 15) {
    credits = Math.round((baseCredits * durationSec) / 15);
  }

  // Reference-video surcharge = (unit_price / 2) × input_duration, expressed in
  // credits. Derive it from baseCredits rather than a second dollar table:
  // baseCredits already encodes unit_price × bucketSec at this file's basis
  // ($0.012/credit at the Business rate — e.g. 8s/720p/Quality is 315 cr for
  // Seedance 2.5's $2.80, i.e. 112.5 cr per provider dollar), so credits-per-input-
  // second is just baseCredits / bucketSec and the margin stays identical
  // across every resolution and the fast/quality split for free.
  const bucketSec = is15 ? 15 : 8;
  const inputSec = Math.max(0, args.inputDurationSec ?? 0);
  const surcharge = Math.round((baseCredits / bucketSec) * (inputSec / 2));
  return { action, credits: credits + surcharge, surcharge };
}

// =====================================================
// Avatar-gen price helper
// =====================================================

/** Maps avatar quality to a credit price + stable action key. Avatar is
 *  capped to 480p/720p (the engine does not offer 1080p). */
export function priceForAvatar(
  quality: '480p' | '720p',
): { action: CreditAction; credits: number } {
  const action: CreditAction = quality === '720p' ? 'avatar_video_720p' : 'avatar_video_480p';
  return { action, credits: CREDIT_PRICES[action] };
}

// =====================================================
// Motion-graphics price helper
// =====================================================

/** Flat per render: CREDIT_PRICES.video_motion_graphics per started 8s. */
export function priceForMotion(durationSec: number): { action: CreditAction; credits: number } {
  const action: CreditAction = 'video_motion_graphics';
  return { action, credits: CREDIT_PRICES[action] * Math.max(1, Math.ceil(durationSec / 8)) };
}

/** CREDIT_PRICES.video_motion_ai per second of output, length clamped to 6–20s. */
export function priceForMotionAi(durationSec: number): { action: CreditAction; credits: number } {
  const action: CreditAction = 'video_motion_ai';
  const { min, max } = MOTION_AI.durationSec;
  const sec = Math.min(max, Math.max(min, Math.round(durationSec) || min));
  return { action, credits: CREDIT_PRICES[action] * sec };
}

// =====================================================
// Text-post price helper
// =====================================================

export function priceForCompose(args: {
  withTools: boolean;
  extraSearches?: number; // count of web_search calls beyond the first bundled one
}): { action: CreditAction; credits: number; surcharge: number } {
  const base = args.withTools ? CREDIT_PRICES.text_post_research : CREDIT_PRICES.text_post;
  const extra = Math.max(0, args.extraSearches ?? 0);
  const surcharge = extra * CREDIT_PRICES.web_search_extra;
  return {
    action: args.withTools ? 'text_post_research' : 'text_post',
    credits: base + surcharge,
    surcharge,
  };
}

/**
 * Credits we charge per dollar the video backend charges us.
 *
 * Pinned to the basis the rest of this file already uses: 8s/720p/Quality is
 * 315 cr against a $2.80 provider cost, i.e. 112.5 cr per provider dollar at
 * $0.012/credit (the Business rate). Cinema is priced off a live quote rather
 * than a bucket, so it needs the ratio stated rather than baked into a
 * constant — change this one number to move Cinema's margin, and nothing else.
 */
export const CREDITS_PER_PROVIDER_USD = 112.5;

/** Round UP. A render that costs a fraction of a credit still costs us money. */
export function creditsFromProviderUsd(usd: number): number {
  return Math.max(1, Math.ceil(usd * CREDITS_PER_PROVIDER_USD));
}

// =====================================================
// Chat / vision price helper (POST /api/v1/chat/completions)
// =====================================================

/** Which model tier of lib/ai/client.ts MODELS serves the call. */
export type ChatTier = 'smart' | 'fast';

/**
 * Provider list price, USD per 1M tokens, for the model each tier maps to by
 * default (MODELS.smart = gpt-5, MODELS.fast = gpt-5-mini). Image inputs arrive
 * already counted inside the provider's prompt_tokens, and reasoning tokens
 * inside its completion_tokens, so these two rates cover everything billed.
 * Cached input is billed at the full input rate — a small overcharge, kept for
 * simplicity. MANDATORY: if OPENAI_MODEL / OPENAI_MODEL_FAST are pointed at a
 * dearer model, update this table, or chat is sold below cost.
 */
export const CHAT_USD_PER_MTOK: Record<ChatTier, { input: number; output: number }> = {
  smart: { input: 1.25, output: 10 },
  fast: { input: 0.25, output: 2 },
};

/**
 * Credits for one chat call, from token counts.
 *
 * Same margin philosophy as every other variable price in this file: provider
 * USD × CREDITS_PER_PROVIDER_USD (112.5 cr per $), rounded UP, minimum 1 — i.e.
 * creditsFromProviderUsd(). At the Business rate ($0.012/cr) that is $1.35 of
 * revenue per $1 of provider cost (~26% margin); at the retail top-up rate
 * (1,000 cr = ₹1,499 ≈ $17.6, so ≈ $0.0176/cr) it is ≈ $1.98 per $1 (~49%).
 *
 * Worked examples (smart tier):
 *   caption, 1,500 in / 500 out: 1500×$1.25/1M + 500×$10/1M = $0.006875
 *     → ×112.5 = 0.77 → ceil → 1 credit
 *   one product photo (~1,100 image tokens + 300 text) in / 400 out:
 *     1400×$1.25/1M + 400×$10/1M = $0.00575 → 0.65 → 1 credit
 *   long answer, 3,000 in / 4,000 out: $0.04375 → 4.92 → 5 credits
 * So the 1-credit floor dominates ordinary calls; only long outputs climb.
 *
 * Also used with a worst-case token estimate for the pre-flight balance check.
 */
export function priceForChat(
  tier: ChatTier,
  promptTokens: number,
  completionTokens: number,
): { action: CreditAction; credits: number; usd: number } {
  const rate = CHAT_USD_PER_MTOK[tier];
  const usd = (Math.max(0, promptTokens) * rate.input + Math.max(0, completionTokens) * rate.output) / 1_000_000;
  return { action: 'text_chat', credits: creditsFromProviderUsd(usd), usd };
}

/**
 * Canvas area the Cinema backend renders at, per quality tier.
 *
 * 0.98 MP is 1344x768 — above 720p's 0.92 MP, below 1080p's 2.07, which is why
 * lib/ai/models.ts does not offer 1080p on this model rather than quietly
 * serving something smaller than the name promises.
 */
export const CINEMA_MEGAPIXELS: Record<'480p' | '720p', number> = {
  '480p': 0.4,
  '720p': 0.98,
};

/** Sampler steps Cinema renders at. Cost is linear in this, so it is a price
 *  lever, not a hidden default: 20 is the backend's own standard. */
export const CINEMA_STEPS = 20;

// =====================================================
// Human-readable labels for the ledger UI
// =====================================================
export const ACTION_LABELS: Record<CreditAction, string> = {
  text_post: 'Text post',
  text_post_research: 'Text post (research)',
  web_search_extra: 'Extra web search',
  image_low_1024: 'Image · low · square',
  image_medium_1024: 'Image · medium · square',
  image_medium_portrait: 'Image · medium · portrait/landscape',
  image_high_1024: 'Image · high · square',
  image_high_portrait: 'Image · high · portrait/landscape',
  image_reference: 'Image · reference input (per image)',
  video_8s_480p_fast: 'Video · 8s · 480p · Fast',
  video_8s_480p_quality: 'Video · 8s · 480p · Quality',
  video_8s_720p_fast: 'Video · 8s · 720p · Fast',
  video_8s_720p_quality: 'Video · 8s · 720p · Quality',
  video_8s_1080p_quality: 'Video · 8s · 1080p · Quality',
  video_15s_480p_quality: 'Video · 15s · 480p · Quality',
  video_15s_720p_quality: 'Video · 15s · 720p · Quality',
  video_15s_1080p_quality: 'Video · 15s · 1080p · Quality',
  variant_regenerate: 'Variant regenerated',
  agent_draft: 'Agent draft',
  publish_x: 'Posted to X',
  voice_twin_create: 'Voice Twin created',
  tts_synthesis: 'Text-to-speech',
  avatar_video_480p: 'Avatar video · 480p',
  avatar_video_720p: 'Avatar video · 720p',
  video_cinema: 'Video · Cinema (sound-on)',
  video_motion_graphics: 'Video · Motion graphic',
  video_motion_ai: 'Video · AI-designed motion graphic',
  text_chat: 'API chat / vision',
};

// Suppress unused-import warning while keeping the type available to consumers.
export type { Platform };
