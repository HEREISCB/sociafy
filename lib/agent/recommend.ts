import type { Platform } from '../db/schema';

// Posts/week that each platform rewards without reading as spam — the usual
// published guidance (X is a feed you can post to daily; LinkedIn punishes
// more than about one a day; YouTube is weekly).
const BASE: Record<Platform, number> = { x: 5, linkedin: 3, instagram: 4, facebook: 3, tiktok: 4, youtube: 1, reddit: 2 };

// Who the niche sells to decides where the extra volume goes.
const B2B = ['saas', 'devtools', 'fintech', 'ai', 'marketing'];
const CONSUMER = ['creator-economy', 'media', 'design', 'community'];

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
      : b2b ? 'Your niches sell to businesses — buyers are on LinkedIn and X, so those get the most posts.'
      : consumer ? 'Your niches are consumer and creator led — Instagram and TikTok reward frequent posting, so those get the most.'
      : 'A steady baseline for each platform. Pick niches to tune it.',
  };
}
