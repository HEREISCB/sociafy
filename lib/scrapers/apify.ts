/* Live Instagram trend scraping via Apify. Runs the hashtag scraper once per
   tracked hashtag and maps the dataset rows into TrendPostInput. Registry routes
   here whenever APIFY_TOKEN is set; falls back to the dummy adapter otherwise. */
import type { TrendPostInput } from '../taccv/trend-analysis';
import type { TrendScraper } from './types';
import { runActor, extractAudio, toInt, isApifyQuotaError, type IgMusicInfo } from './apify-client';

const HASHTAG_ACTOR = 'apify~instagram-hashtag-scraper';
const DEFAULT_LIMIT = 30;

type IgHashtagPost = {
  url?: string;
  type?: string;
  productType?: string;
  caption?: string;
  hashtags?: string[];
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
  ownerUsername?: string;
  timestamp?: string;
  musicInfo?: IgMusicInfo;
};

function perHashtagLimit(): number {
  const n = Number(process.env.APIFY_TREND_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
}

function mapPost(hashtag: string, p: IgHashtagPost): TrendPostInput | null {
  if (!p.url) return null;
  const isReel = String(p.productType ?? '').toLowerCase() === 'clips' || p.type === 'Video';
  const { title, artist } = extractAudio(p.musicInfo ?? null);
  return {
    hashtagQueried: hashtag,
    postUrl: p.url,
    owner: p.ownerUsername ?? null,
    likes: toInt(p.likesCount),
    comments: toInt(p.commentsCount),
    views: toInt(p.videoViewCount ?? p.videoPlayCount),
    type: p.type ?? null,
    isReel,
    postHashtags: Array.isArray(p.hashtags) ? p.hashtags : [],
    caption: p.caption ?? null,
    audioTitle: title,
    audioArtist: artist,
    postedAt: p.timestamp ?? null,
  };
}

export const apifyTrendScraper: TrendScraper = {
  async fetchTrends(hashtags: string[]): Promise<TrendPostInput[]> {
    const clean = [...new Set(hashtags.map((h) => h.replace(/[^a-zA-Z0-9_]/g, '')).filter(Boolean))];
    if (clean.length === 0) return [];
    const limit = perHashtagLimit();

    // one actor run per hashtag so each post is attributed to the tag it was queried under
    const runs = await Promise.allSettled(
      clean.map((tag) =>
        runActor<IgHashtagPost>(HASHTAG_ACTOR, { hashtags: [tag], resultsType: 'posts', resultsLimit: limit })
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
    // if every run failed on an account-level Apify error (quota/rate limit),
    // surface it instead of returning an empty "no data" result
    if (out.length === 0) {
      const quota = runs.find((r) => r.status === 'rejected' && isApifyQuotaError(r.reason));
      if (quota && quota.status === 'rejected') throw quota.reason;
    }
    return out;
  },
};
