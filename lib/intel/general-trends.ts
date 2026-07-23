/* Fixed India-wide "general/cultural" bucket catalog + the pure grouping logic
   that turns general trend posts (queried under GENERAL_CATALOG_TAGS instead of
   a tracked niche hashtag) into per-bucket top reels/posts/audio — the "Analysis ·
   General" surface (V2_Plan.md §3). One representative tag per bucket bounds
   Apify cost; ⚠ 5 category runs per refresh under live keys — trim/toggle in
   refresh.ts if that cost matters. */
import type { TrendPostInput } from '../taccv/trend-analysis';
import { normalizeHashtag } from '../text/hashtag';

export const GENERAL_CATALOG: Record<string, { label: string; tags: string[] }> = {
  entertainment: { label: 'Entertainment', tags: ['bollywood'] },
  news: { label: 'News', tags: ['news'] },
  sports: { label: 'Sports', tags: ['cricket'] },
  viral: { label: 'Viral', tags: ['viral'] },
  dance: { label: 'Dance', tags: ['dance'] },
};

export const GENERAL_CATALOG_TAGS: string[] = Object.values(GENERAL_CATALOG).flatMap((b) => b.tags);

const TAG_TO_BUCKET = new Map<string, string>(
  Object.entries(GENERAL_CATALOG).flatMap(([bucket, { tags }]) => tags.map((t) => [normalizeHashtag(t), bucket])),
);

export function bucketForTag(tag: string): string | null {
  return TAG_TO_BUCKET.get(normalizeHashtag(tag)) ?? null;
}

type ScoredPost = {
  url: string; owner: string | null; caption: string; type: string; isReel: boolean; score: number;
  audioTitle: string | null; audioArtist: string | null;
};

export type GeneralBucket = {
  bucket: string;
  label: string;
  topReels: ScoredPost[];
  topPosts: ScoredPost[];
  topAudio: Array<{ track: string; n: number; score: number; topPostUrl: string }>;
};

/** score = likes + comments, same math/shape as buildTrendData so the UI vocabulary stays identical. */
export function buildGeneralTrends(generalPosts: TrendPostInput[]): GeneralBucket[] {
  const byBucket = new Map<string, ScoredPost[]>();
  for (const p of generalPosts) {
    const bucket = bucketForTag(p.hashtagQueried);
    if (!bucket) continue;
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket)!.push({
      url: p.postUrl, owner: p.owner, caption: p.caption ?? '', type: p.type ?? 'Unknown',
      isReel: Boolean(p.isReel), score: (p.likes ?? 0) + (p.comments ?? 0),
      audioTitle: p.audioTitle ?? null, audioArtist: p.audioArtist ?? null,
    });
  }

  const result: GeneralBucket[] = [];
  for (const [bucket, { label }] of Object.entries(GENERAL_CATALOG)) {
    const posts = byBucket.get(bucket);
    if (!posts || posts.length === 0) continue;

    const seen = new Set<string>();
    const deduped = posts.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)));
    const sorted = [...deduped].sort((a, b) => b.score - a.score);

    const audioMap = new Map<string, { n: number; score: number; topPostUrl: string; topScore: number }>();
    for (const p of sorted) {
      if (!p.audioTitle) continue;
      const key = `${p.audioArtist || 'Unknown'} — ${p.audioTitle}`;
      const entry = audioMap.get(key) ?? { n: 0, score: 0, topPostUrl: p.url, topScore: -Infinity };
      entry.n += 1;
      entry.score += p.score;
      if (p.score > entry.topScore) { entry.topScore = p.score; entry.topPostUrl = p.url; }
      audioMap.set(key, entry);
    }
    const topAudio = [...audioMap.entries()]
      .map(([track, v]) => ({ track, n: v.n, score: v.score, topPostUrl: v.topPostUrl }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    result.push({
      bucket,
      label,
      topReels: sorted.filter((p) => p.isReel).slice(0, 12),
      topPosts: sorted.filter((p) => !p.isReel).slice(0, 12),
      topAudio,
    });
  }
  return result;
}
