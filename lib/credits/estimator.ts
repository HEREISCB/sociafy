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

import { priceForImage, priceForVideo, CREDIT_PRICES } from './pricing';
import type { PostKind } from '../platforms/capabilities';
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
/** What autopilot generates for an image or video post. lib/agent/media.ts
 *  renders with exactly these, so the forecast and the bill cannot drift. */
export const AGENT_IMAGE = { size: '1024x1024', quality: 'medium' } as const;
export const AGENT_VIDEO = { durationSec: 8, quality: '720p', fast: true, aspect: '9:16' } as const;

/** Credits one autopilot draft of this kind costs: the copy, plus its media. */
export function draftCost(kind: PostKind): number {
  return CREDIT_PRICES.agent_draft + (
    kind === 'image' ? priceForImage(AGENT_IMAGE.size, AGENT_IMAGE.quality).credits
    : kind === 'video' ? priceForVideo(AGENT_VIDEO).credits
    : 0
  );
}

export function estimateWeeklyBurn(plan: AutopilotPlan): EstimatorResult {
  const mix = plan.postsPerWeekByContentType;
  const byKind = {
    text:  Math.max(0, mix.text)  * draftCost('text'),
    image: Math.max(0, mix.image) * draftCost('image'),
    video: Math.max(0, mix.video) * draftCost('video'),
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
