import type { TrendScraper } from './types';
import type { TrendPlatform } from '../db/schema';
import { dummyTrendScraper } from './dummy';
import { apifyTrendScraper } from './apify';
import { tiktokTrendScraper } from './tiktok';
import { youtubeTrendScraper } from './youtube';

const LIVE_SCRAPERS: Record<TrendPlatform, TrendScraper> = {
  instagram: apifyTrendScraper,
  tiktok: tiktokTrendScraper,
  youtube: youtubeTrendScraper,
};

export function getTrendScraper(platform: TrendPlatform = 'instagram'): TrendScraper {
  return process.env.APIFY_TOKEN ? LIVE_SCRAPERS[platform] : dummyTrendScraper;
}

export function trendSource(): 'seed' | 'apify' {
  return process.env.APIFY_TOKEN ? 'apify' : 'seed';
}
