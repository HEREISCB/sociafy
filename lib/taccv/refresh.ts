import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { trendSnapshots, trendPosts, trendSettings, activityLog, type TrendPlatform } from '../db/schema';
import { getTrendScraper, trendSource } from '../scrapers/registry';
import { isApifyQuotaError } from '../scrapers/apify-client';
import { GENERAL_CATALOG_TAGS } from '../intel/general-trends';

const FRESHNESS_MS = 2 * 86_400_000;

// Generic Instagram-wide reference tags — one per GENERAL_CATALOG bucket
// (entertainment/news/sports/viral/dance), scraped alongside the user's own
// niche hashtags (Instagram-only) so Trends can show a real general-vs-niche
// comparison AND bucket into buildGeneralTrends. Each is a real Apify run, so
// this is a real recurring cost on top of the niche scrape, not a free addition.
// Re-exported under its original name — nothing outside this file imports it,
// but keeping the name stable costs nothing.
export const GENERAL_REFERENCE_HASHTAGS = GENERAL_CATALOG_TAGS;

export type RefreshResult =
  | { skipped: true; reason: 'fresh' | 'no_data' }
  | { skipped: true; reason: 'apify_error'; error: string }
  | { skipped: false; snapshotId: string; postCount: number };

export async function refreshTrends(userId: string, force = false, platform: TrendPlatform = 'instagram'): Promise<RefreshResult> {
  const [latest] = await db()
    .select({ fetchedAt: trendSnapshots.fetchedAt })
    .from(trendSnapshots)
    .where(and(eq(trendSnapshots.userId, userId), eq(trendSnapshots.platform, platform)))
    .orderBy(desc(trendSnapshots.fetchedAt))
    .limit(1);

  if (!force && latest && Date.now() - latest.fetchedAt.getTime() < FRESHNESS_MS) {
    return { skipped: true, reason: 'fresh' };
  }

  const [settings] = await db().select().from(trendSettings).where(eq(trendSettings.userId, userId)).limit(1);
  const nicheHashtags = settings?.trackedHashtags ?? [];
  // general reference tags are Instagram-only and skipped if a niche tag already
  // covers one (no point paying for a duplicate run)
  const hashtags = platform === 'instagram'
    ? [...new Set([...nicheHashtags, ...GENERAL_REFERENCE_HASHTAGS])]
    : nicheHashtags;

  let posts;
  try {
    posts = await getTrendScraper(platform).fetchTrends(hashtags, userId, platform);
  } catch (e) {
    if (isApifyQuotaError(e)) return { skipped: true, reason: 'apify_error', error: e.message };
    throw e;
  }
  if (posts.length === 0) return { skipped: true, reason: 'no_data' };

  const now = new Date();
  const label = `${platform}_${now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})/, '$1_')}`;
  const [snap] = await db().insert(trendSnapshots).values({
    userId, label, source: trendSource(), platform, fetchedAt: now, postCount: posts.length,
  }).returning({ id: trendSnapshots.id });

  for (let i = 0; i < posts.length; i += 500) {
    await db().insert(trendPosts).values(
      posts.slice(i, i + 500).map((p) => ({
        snapshotId: snap.id,
        hashtagQueried: p.hashtagQueried,
        postUrl: p.postUrl,
        likes: p.likes ?? 0,
        comments: p.comments ?? 0,
        views: p.views ?? 0,
        caption: p.caption,
        postHashtags: p.postHashtags ?? [],
        owner: p.owner,
        ownerFollowers: p.ownerFollowers ?? 0,
        type: p.type,
        isReel: p.isReel ?? false,
        audioTitle: p.audioTitle,
        audioArtist: p.audioArtist,
        fetchedAt: now,
      })),
    );
  }

  await db().insert(activityLog).values({
    userId, kind: 'trend_refresh',
    title: `${platform === 'instagram' ? 'Trend' : platform[0].toUpperCase() + platform.slice(1)} snapshot refreshed (${posts.length} posts)`,
  });

  return { skipped: false, snapshotId: snap.id, postCount: posts.length };
}
