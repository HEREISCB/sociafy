/* Live YouTube trend scraping via Apify (streamers/youtube-scraper). Same shape
   as apify.ts / tiktok.ts — one actor run per tracked term, restricted to Shorts
   (maxResultsShorts) since those are the format that actually transfers into
   Instagram Reels trends, mapped into the same TrendPostInput the forecast
   engine consumes under platform 'youtube'. */
import type { TrendPostInput } from '../taccv/trend-analysis';
import type { TrendScraper } from './types';
import { runActor, toInt, isApifyQuotaError } from './apify-client';

const SEARCH_ACTOR = 'streamers~youtube-scraper';
const DEFAULT_LIMIT = 20;

type YtItem = {
  url?: string;
  title?: string;
  viewCount?: number;
  likes?: number;
  commentsCount?: number;
  date?: string;
  channelName?: string;
  numberOfSubscribers?: number;
};

function perQueryLimit(): number {
  const n = Number(process.env.APIFY_TREND_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
}

// YouTube gives no structured hashtag list — pull #tags out of the title, same
// vocabulary the tracked-hashtag term itself came from.
function extractHashtags(title: string | undefined): string[] {
  return [...new Set((title ?? '').match(/#\w+/g)?.map((t) => t.slice(1)) ?? [])];
}

function mapItem(term: string, p: YtItem): TrendPostInput | null {
  if (!p.url) return null;
  return {
    hashtagQueried: term,
    postUrl: p.url,
    owner: p.channelName ?? null,
    ownerFollowers: toInt(p.numberOfSubscribers),
    likes: toInt(p.likes),
    comments: toInt(p.commentsCount),
    views: toInt(p.viewCount),
    type: 'Video',
    isReel: true,
    postHashtags: extractHashtags(p.title),
    caption: p.title ?? null,
    audioTitle: null,
    audioArtist: null,
    postedAt: p.date ?? null,
  };
}

export const youtubeTrendScraper: TrendScraper = {
  async fetchTrends(hashtags: string[]): Promise<TrendPostInput[]> {
    const terms = [...new Set(hashtags.map((h) => h.replace(/[^a-zA-Z0-9_]/g, ' ').trim()).filter(Boolean))];
    if (terms.length === 0) return [];
    const limit = perQueryLimit();

    const runs = await Promise.allSettled(
      terms.map((term) =>
        runActor<YtItem>(SEARCH_ACTOR, { searchQueries: [term], maxResults: 0, maxResultsShorts: limit, sortingOrder: 'date' })
          .then((items) => items.map((p) => mapItem(term, p)).filter((r): r is TrendPostInput => r !== null)),
      ),
    );

    const seen = new Set<string>();
    const out: TrendPostInput[] = [];
    for (const r of runs) {
      if (r.status !== 'fulfilled') continue;
      for (const post of r.value) {
        if (seen.has(post.postUrl)) continue;
        seen.add(post.postUrl);
        out.push(post);
      }
    }
    if (out.length === 0) {
      const quota = runs.find((r) => r.status === 'rejected' && isApifyQuotaError(r.reason));
      if (quota && quota.status === 'rejected') throw quota.reason;
    }
    return out;
  },
};
