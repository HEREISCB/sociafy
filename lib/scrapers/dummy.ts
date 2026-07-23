/* Demo scraper: re-samples the user's latest snapshot with jittered engagement,
   so "Refresh" visibly produces a new snapshot without any external API. */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { trendSnapshots, trendPosts } from '../db/schema';
import type { TrendPostInput } from '../taccv/trend-analysis';
import type { TrendScraper } from './types';

export const dummyTrendScraper: TrendScraper = {
  async fetchTrends(_hashtags: string[], userId: string, platform = 'instagram' as const): Promise<TrendPostInput[]> {
    const [latest] = await db()
      .select({ id: trendSnapshots.id })
      .from(trendSnapshots)
      .where(and(eq(trendSnapshots.userId, userId), eq(trendSnapshots.platform, platform)))
      .orderBy(desc(trendSnapshots.fetchedAt))
      .limit(1);
    if (!latest) return [];

    const rows = await db().select().from(trendPosts).where(eq(trendPosts.snapshotId, latest.id));
    return rows.map((r) => {
      const jitter = 0.85 + Math.random() * 0.3;
      return {
        hashtagQueried: r.hashtagQueried,
        postUrl: r.postUrl,
        owner: r.owner,
        likes: r.likes !== null && r.likes >= 0 ? Math.round(r.likes * jitter) : r.likes,
        comments: Math.round((r.comments ?? 0) * jitter),
        type: r.type,
        isReel: r.isReel,
        postHashtags: r.postHashtags,
        caption: r.caption,
        audioTitle: r.audioTitle,
        audioArtist: r.audioArtist,
      };
    });
  },
};
