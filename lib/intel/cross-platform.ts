/* Cross-platform trend radar. Reuses the same parabola-fit forecast engine
   (forecast.ts) that already powers the Instagram viral radar — a TikTok sound
   or YouTube Shorts hashtag is scored exactly the same way an Instagram hashtag
   is, just per-platform. The only new idea here is the cross-check: a TikTok/
   YouTube entity that's rising/emerging, on-niche, and NOT yet present in the
   latest Instagram snapshot is a genuine lead-time opportunity — prep it now,
   post while it's still rising, before Instagram saturates on it (see the
   proposal/tower-arrest trend case: caught 2 days late = trend already dead).
   Pure + deterministic; DB orchestration lives in cross-platform-radar.ts. */
import { nicheFitBase, normTag, type Forecast, type ForecastRow } from './forecast';
import type { TrendPlatform } from '../db/schema';

// entities peaking this soon or sooner get the "act now" tier
export const HIGH_ALERT_HOURS = 24;

export type CrossPlatformOpportunity = Forecast & {
  platform: TrendPlatform;
  highAlert: boolean;
};

export type PlatformForecastInput = {
  platform: TrendPlatform;
  forecasts: Forecast[];
  allRows: ForecastRow[]; // for nicheFitBase co-occurrence scoring
};

/** Normalized set of hashtag/audio entities already present in the latest
    Instagram snapshot — used to drop TikTok/YouTube entities that have already
    caught on there (no lead-time opportunity left). */
export function instagramEntitySet(instagramRows: ForecastRow[]): Set<string> {
  const set = new Set<string>();
  for (const r of instagramRows) {
    if (r.hashtagQueried) set.add(normTag(r.hashtagQueried));
    for (const t of r.postHashtags ?? []) set.add(normTag(t));
    if (r.audioTitle) set.add(normTag(r.audioTitle));
  }
  return set;
}

export function crossPlatformOpportunities(
  sources: PlatformForecastInput[],
  nicheTags: string[],
  nicheText: string | null,
  instagramEntities: Set<string>,
  minFit = 40,
): CrossPlatformOpportunity[] {
  const out: CrossPlatformOpportunity[] = [];
  for (const { platform, forecasts, allRows } of sources) {
    if (platform === 'instagram') continue;
    for (const f of forecasts) {
      if (f.stage === 'declining') continue;
      if (instagramEntities.has(normTag(f.entity))) continue; // already spread to IG — no lead time left
      const fit = nicheFitBase(f.entity, allRows, nicheTags, nicheText);
      if (fit < minFit) continue;
      out.push({
        ...f,
        fitBase: fit,
        platform,
        highAlert: f.hoursToPeak !== null && f.hoursToPeak >= -6 && f.hoursToPeak <= HIGH_ALERT_HOURS,
      });
    }
  }
  return out.sort((a, b) => (b.fitBase ?? 0) - (a.fitBase ?? 0) || (a.hoursToPeak ?? 999) - (b.hoursToPeak ?? 999));
}
