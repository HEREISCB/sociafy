/* Scraper contracts mirror the Apify actor outputs so the live adapter can
   slot in without touching callers. Dummy adapter is active until then. */
import type { TrendPostInput } from '../taccv/trend-analysis';
import type { TrendPlatform } from '../db/schema';

export interface ScrapedCreator {
  username: string;
  followers: number;
  following: number;
  bio: string;
  location: string;
  avgLikes: number;
  avgComments: number;
  engagementRate: number;
  botScore: number;
  botLabel: string;
  botExplanation: string;
  posts: Array<{
    url: string; type: string; isReel: boolean;
    likes: number; comments: number; score: number;
    caption: string; postedAt: string | null; thumbnail: string | null;
  }>;
}

export interface TrendScraper {
  /** Fetch fresh posts for the tracked hashtags. `platform` is only meaningful to
      the dummy adapter, which shares one implementation across all platforms and
      needs it to avoid resampling the wrong platform's snapshot. */
  fetchTrends(hashtags: string[], userId: string, platform?: TrendPlatform): Promise<TrendPostInput[]>;
}

export interface CreatorScraper {
  fetchCreator(username: string): Promise<ScrapedCreator>;
}
