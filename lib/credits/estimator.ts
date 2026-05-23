/**
 * Weekly credit forecast for the autopilot.
 *
 * Used by:
 *   - onboarding Plan step (live as the user tweaks the sliders)
 *   - /agent page autopilot rules card (sticky banner)
 *
 * Pure function — no DB, no I/O. Same `priceFor*` helpers the server uses
 * to charge real generations, so the preview can't drift from reality.
 */

import { priceForImage, priceForVideo, priceForCompose, CREDIT_PRICES } from './pricing';
import type { Platform } from '../db/schema';

export type ContentMixWeekly = {
  text: number;
  image: number;
  video: number;
};

export type AutopilotPlan = {
  /** Platforms the agent is allowed to post to. */
  platforms: Platform[];
  /** Total posts/week, used when per-platform caps aren't set. */
  cadencePerWeek: number;
  /** Per-platform overrides — if set, sum drives the total instead. */
  postsPerWeekByPlatform?: Partial<Record<Platform, number>>;
  /** Posts/week of each content kind. Agent fans these out to platforms. */
  postsPerWeekByContentType: ContentMixWeekly;
  /** Whether autopilot uses research-mode caption gen (more expensive). */
  withResearch?: boolean;
  /** Image gen defaults — use what compose's medium-1024 charges. */
  imageQuality?: 'low' | 'medium' | 'high';
  /** Video gen defaults — 720p Quality 8s reel matches our recommended tier. */
  videoQuality?: '480p' | '720p' | '1080p';
  videoDurationSec?: number;
  videoFast?: boolean;
};

export type EstimatorResult = {
  /** Total credits burned per week at this plan. */
  weekly: number;
  /** Breakdown by content kind — useful for chart bars. */
  byKind: { text: number; image: number; video: number };
  /** Posts/week implied by the inputs. */
  totalPosts: number;
  /** Per-post cost averaged across the mix (helps users build intuition). */
  avgCostPerPost: number;
};

/**
 * Estimate weekly credit burn for a given plan.
 *
 * Strategy: we count *unique posts/week* of each content kind, charge the
 * "base" generation cost once per post, and (for image/video) assume one
 * media gen per post. This mirrors what `lib/agent/run.ts` actually does:
 * generate caption → optionally generate one media asset → schedule.
 *
 * NOT modeled today (would inflate the estimate without much accuracy):
 *   - Multi-image carousels (agent only generates one image per post)
 *   - Regenerations (these would only happen if the user manually tweaks)
 *   - Extra web_search calls beyond the bundled one (rare)
 */
export function estimateWeeklyBurn(plan: AutopilotPlan): EstimatorResult {
  const mix = plan.postsPerWeekByContentType;
  const withResearch = plan.withResearch ?? false;

  const composeCost = priceForCompose({ withTools: withResearch }).credits;

  // Per-post costs by kind. Each post incurs the caption cost. Image/video
  // posts also incur a media-gen cost.
  const textPostCost = composeCost;
  const imagePostCost =
    composeCost +
    priceForImage('1024x1024', plan.imageQuality ?? 'medium').credits;
  const videoPostCost =
    composeCost +
    priceForVideo({
      durationSec: plan.videoDurationSec ?? 8,
      quality: plan.videoQuality ?? '720p',
      fast: plan.videoFast ?? false,
    }).credits;

  const byKind = {
    text:  Math.max(0, mix.text)  * textPostCost,
    image: Math.max(0, mix.image) * imagePostCost,
    video: Math.max(0, mix.video) * videoPostCost,
  };
  const weekly = byKind.text + byKind.image + byKind.video;
  const totalPosts = Math.max(0, mix.text + mix.image + mix.video);
  const avgCostPerPost = totalPosts > 0 ? Math.round(weekly / totalPosts) : 0;

  return { weekly, byKind, totalPosts, avgCostPerPost };
}

/**
 * Given the user's balance + their estimated weekly burn, how many weeks
 * does their budget cover? Returns -1 for "infinite" (weekly = 0).
 */
export function weeksOfRunway(weeklyBurn: number, balance: number): number {
  if (weeklyBurn <= 0) return -1;
  return Math.floor(balance / weeklyBurn);
}

// Re-export CREDIT_PRICES for callers building inline labels.
export { CREDIT_PRICES };
