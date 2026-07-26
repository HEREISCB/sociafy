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
  | 'avatar_video_720p';

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
  video_8s_480p_fast: 75,
  video_8s_480p_quality: 90,
  video_8s_720p_fast: 145,
  video_8s_720p_quality: 180,
  video_8s_1080p_quality: 445,
  video_15s_480p_quality: 168,        // 15s @ 480p Quality (Seedance $0.10/s)
  video_15s_720p_quality: 335,
  video_15s_1080p_quality: 835,
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
};

export function creditsFor(action: CreditAction): number {
  return CREDIT_PRICES[action];
}

// =====================================================
// Image-gen price helper
// =====================================================
export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536';
export type ImageQuality = 'low' | 'medium' | 'high';

export function priceForImage(
  size: ImageSize,
  quality: ImageQuality,
): { action: CreditAction; credits: number } {
  const isSquare = size === '1024x1024';
  let action: CreditAction;
  if (quality === 'low') {
    // gpt-image-1 low pricing is flat across aspect — both stay at 2 credits.
    action = 'image_low_1024';
  } else if (quality === 'medium') {
    action = isSquare ? 'image_medium_1024' : 'image_medium_portrait';
  } else {
    action = isSquare ? 'image_high_1024' : 'image_high_portrait';
  }
  return { action, credits: CREDIT_PRICES[action] };
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
  // 1080p Fast is not currently offered by Seedance — fall back to Quality.
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
  // (e.g. 6s 720p Quality = 180 * 6/8 = 135.)
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
  // ($0.012/credit at the Business rate — e.g. 8s/720p/Quality is 180 cr for
  // Seedance's $1.60, i.e. 112.5 cr per provider dollar), so credits-per-input-
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
};

// Suppress unused-import warning while keeping the type available to consumers.
export type { Platform };
