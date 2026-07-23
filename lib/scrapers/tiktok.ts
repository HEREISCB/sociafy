/* Live TikTok trend scraping via Apify (clockworks/tiktok-scraper). Same shape
   as apify.ts's Instagram hashtag scraper — one actor run per tracked tag, mapped
   into the same TrendPostInput the forecast engine already consumes, just tagged
   under platform 'tiktok'. This is what lets a TikTok trend get caught and scored
   for niche-fit before it ever shows up on Instagram. */
import type { TrendPostInput } from '../taccv/trend-analysis';
import type { TrendScraper } from './types';
import { runActor, toInt, isApifyQuotaError } from './apify-client';

const HASHTAG_ACTOR = 'clockworks~tiktok-scraper';
const DEFAULT_LIMIT = 30;

type TtHashtagItem = {
  hashtags?: Array<{ name?: string } | string>;
  webVideoUrl?: string;
  text?: string;
  diggCount?: number;
  commentCount?: number;
  playCount?: number;
  createTimeISO?: string;
  authorMeta?: { name?: string; fans?: number };
  musicMeta?: { musicName?: string; musicAuthor?: string };
};

function perTagLimit(): number {
  const n = Number(process.env.APIFY_TREND_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
}

function tagNames(hashtags: TtHashtagItem['hashtags']): string[] {
  if (!Array.isArray(hashtags)) return [];
  return hashtags.map((h) => (typeof h === 'string' ? h : h?.name ?? '')).filter(Boolean);
}

function mapPost(tag: string, p: TtHashtagItem): TrendPostInput | null {
  if (!p.webVideoUrl) return null;
  return {
    hashtagQueried: tag,
    postUrl: p.webVideoUrl,
    owner: p.authorMeta?.name ?? null,
    ownerFollowers: toInt(p.authorMeta?.fans),
    likes: toInt(p.diggCount),
    comments: toInt(p.commentCount),
    views: toInt(p.playCount),
    type: 'Video',
    isReel: true,
    postHashtags: tagNames(p.hashtags),
    caption: p.text ?? null,
    audioTitle: p.musicMeta?.musicName ?? null,
    audioArtist: p.musicMeta?.musicAuthor ?? null,
    postedAt: p.createTimeISO ?? null,
  };
}

export const tiktokTrendScraper: TrendScraper = {
  async fetchTrends(hashtags: string[]): Promise<TrendPostInput[]> {
    const clean = [...new Set(hashtags.map((h) => h.replace(/[^a-zA-Z0-9_]/g, '')).filter(Boolean))];
    if (clean.length === 0) return [];
    const limit = perTagLimit();

    const runs = await Promise.allSettled(
      clean.map((tag) =>
        runActor<TtHashtagItem>(HASHTAG_ACTOR, { hashtags: [tag], resultsPerPage: limit, proxyCountryCode: 'None' })
          .then((items) => items.map((p) => mapPost(tag, p)).filter((r): r is TrendPostInput => r !== null)),
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
