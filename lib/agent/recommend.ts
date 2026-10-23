import type { Platform } from '../db/schema';
import { supportsKind } from '../platforms/capabilities';

// Posts/week that each platform rewards without reading as spam — the usual
// published guidance (X is a feed you can post to daily; LinkedIn punishes
// more than about one a day; YouTube is weekly).
const BASE: Record<Platform, number> = { x: 5, linkedin: 3, instagram: 4, facebook: 3, tiktok: 4, youtube: 1, reddit: 2 };

// Who the niche sells to decides where the extra volume goes.
const B2B = ['saas', 'devtools', 'fintech', 'ai', 'marketing'];
const CONSUMER = ['creator-economy', 'media', 'design', 'community', 'food-drink', 'local-business', 'retail', 'health-fitness', 'education', 'travel'];

export type PostingPlan = {
  perPlatform: Partial<Record<Platform, number>>;
  /** Drafts/week needed to feed the busiest platform — each draft fans out to all of them. */
  cadencePerWeek: number;
  why: string;
};

export function recommendPlan(platforms: Platform[], niches: string[]): PostingPlan {
  const b2b = niches.some((n) => B2B.includes(n));
  const consumer = niches.some((n) => CONSUMER.includes(n));
  const perPlatform: Partial<Record<Platform, number>> = {};
  for (const p of platforms) {
    const bump =
      (b2b && (p === 'linkedin' || p === 'x') ? 2 : 0) +
      (consumer && (p === 'instagram' || p === 'tiktok') ? 2 : 0);
    perPlatform[p] = BASE[p] + bump;
  }
  return {
    perPlatform,
    cadencePerWeek: Math.max(0, ...Object.values(perPlatform)),
    why: b2b && consumer ? 'Your niches span business and consumer audiences, so LinkedIn, X, Instagram and TikTok all get extra volume.'
      : b2b ? 'Your niches sell to businesses. Buyers are on LinkedIn and X, so those get the most posts.'
      : consumer ? 'Your niches are consumer and creator led. Instagram and TikTok reward frequent posting, so those get the most.'
      : 'A steady baseline for each platform. Pick niches to tune it.',
  };
}

/**
 * Per-platform weekly limits, derived rather than asked for: each platform
 * gets its recommended volume, never more than the plan's weekly total.
 * Every draft fans out to all platforms, so this keeps the quieter ones
 * (LinkedIn, YouTube) from getting the busiest one's volume.
 */
export function platformCaps(platforms: Platform[], niches: string[], postsPerWeek: number): Partial<Record<Platform, number>> {
  const rec = recommendPlan(platforms, niches).perPlatform;
  return Object.fromEntries(platforms.map((p) => [p, Math.min(postsPerWeek, rec[p] ?? postsPerWeek)]));
}

export type MixPreset = 'text' | 'mixed' | 'video';
type Mix = { text: number; image: number; video: number };

const SHARE: Record<MixPreset, { image: number; video: number }> = {
  text: { image: 0, video: 0 },
  mixed: { image: 0.3, video: 0.15 },
  video: { image: 0.2, video: 0.6 },
};

/**
 * One weekly post count + a preset → the text/image/video counts autopilot
 * plans with. Every enabled platform gets at least one post it can publish:
 * TikTok/YouTube force a video, Instagram an image, even on "Text only".
 */
export function mixFor(preset: MixPreset, total: number, platforms: Platform[]): Mix {
  const image = Math.round(total * SHARE[preset].image);
  // The settings API caps video at 20 a week.
  const video = Math.min(20, Math.round(total * SHARE[preset].video));
  const mix: Mix = { text: Math.max(0, total - image - video), image, video };
  for (const p of platforms) {
    const kinds = (['text', 'image', 'video'] as const).filter((k) => supportsKind(p, k));
    if (kinds.some((k) => mix[k] > 0)) continue;
    // Cheapest kind it takes, paid for by the biggest bucket so the total holds.
    const biggest = (['text', 'image', 'video'] as const).reduce((a, b) => (mix[b] > mix[a] ? b : a));
    if (mix[biggest] > 1) mix[biggest]--;
    mix[kinds[0]]++;
  }
  return mix;
}

/** Which preset a saved mix came from, or null for a hand-tuned one. */
export function presetOf(mix: Mix, platforms: Platform[]): MixPreset | null {
  const total = mix.text + mix.image + mix.video;
  return (['text', 'mixed', 'video'] as const).find((p) => {
    const m = mixFor(p, total, platforms);
    return m.text === mix.text && m.image === mix.image && m.video === mix.video;
  }) ?? null;
}
