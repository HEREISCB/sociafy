/* TypeScript port of TACCV/core/trend_analysis.py. Input is TrendPost rows
   (one snapshot) instead of CSV files; math and output shape are identical. */
import { truncateAtWord } from '../text/truncate';
import { normalizeHashtag } from '../text/hashtag';

export interface TrendPostInput {
  hashtagQueried: string;
  postUrl: string;
  owner: string | null;
  likes: number | null;
  comments: number | null;
  views?: number | null;
  ownerFollowers?: number | null;
  type: string | null;
  isReel: boolean | null;
  postHashtags: string[] | null;
  caption: string | null;
  audioTitle: string | null;
  audioArtist: string | null;
  postedAt?: string | null;
}

// Fallback only; callers pass the tracked hashtags as stop tags so the queried
// tags don't dominate the co-occurrence rollup. Empty = strip nothing by default.
const DEFAULT_STOP_TAGS = new Set<string>();

type CleanRow = {
  category: string;
  url: string;
  owner: string;
  likes: number | null;
  comments: number;
  score: number;
  type: string;
  is_reel: boolean;
  tags: string[];
  caption: string;
  hidden_likes: boolean;
  audio_title: string | null;
  audio_artist: string | null;
};

const TYPE_MAP: Record<string, string> = { Sidecar: 'Carousel', GraphImage: 'Image' };

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function avg(xs: Array<number | null>): number {
  const vals = xs.filter((x): x is number => x !== null);
  return vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
}

function cleanRow(row: TrendPostInput, stopTags: Set<string>): CleanRow {
  let likes: number | null = row.likes ?? null;
  if (likes !== null && likes < 0) likes = null;
  const comments = row.comments ?? 0;
  const rawType = (row.type ?? '').trim();
  const type = (TYPE_MAP[rawType] ?? rawType) || 'Unknown';
  const tags = (row.postHashtags ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && !stopTags.has(t));
  return {
    category: row.hashtagQueried.trim(),
    url: (row.postUrl ?? '').trim(),
    owner: (row.owner ?? '').trim(),
    likes,
    comments,
    score: (likes ?? 0) + comments,
    type,
    is_reel: Boolean(row.isReel),
    tags,
    caption: (row.caption ?? '').split(/\s+/).filter(Boolean).join(' '),
    hidden_likes: likes === null,
    audio_title: row.audioTitle || null,
    audio_artist: row.audioArtist || null,
  };
}

export interface TrendData {
  source: string;
  kpis: { posts: number; creators: number; total_eng: number; avg_eng: number; hidden_pct: number; reels_pct: number };
  categories: Array<{ name: string; n: number; avg: number; total: number; scope: 'niche' | 'general' }>;
  formats: Array<{ name: string; n: number; avg: number }>;
  hashtags: Array<{ tag: string; n: number; avg: number }>;
  top_audio: Array<{ track: string; n: number; score: number }>;
  creators: Array<{ owner: string; total: number; n: number }>;
  top_posts: Array<Pick<CleanRow, 'url' | 'owner' | 'category' | 'type' | 'is_reel' | 'score' | 'likes' | 'comments' | 'caption'>>;
  rec: { category: string; format: string; format_lift: number; tags: string[]; hooks: Array<{ hook: string; score: number }> };
}

export function buildTrendData(
  input: TrendPostInput[],
  sourceLabel: string,
  stopTagList: string[] = [],
  nicheHashtags: string[] = [],
): TrendData | null {
  if (input.length === 0) return null;
  const stopTags = stopTagList.length
    ? new Set(stopTagList.map((t) => t.toLowerCase()))
    : DEFAULT_STOP_TAGS;
  // scope a category as 'niche' if it's one of the user's own tracked hashtags,
  // else 'general' (a fixed reference tag scraped alongside them — see refresh.ts).
  // Empty nicheHashtags (old callers, parity script) means "don't split" — treat
  // everything as niche rather than silently mislabeling as general.
  const nicheSet = new Set(nicheHashtags.map(normalizeHashtag));
  const scopeOf = (name: string): 'niche' | 'general' =>
    (nicheSet.size === 0 || nicheSet.has(normalizeHashtag(name))) ? 'niche' : 'general';
  const rows = input.map((r) => cleanRow(r, stopTags));

  // KPIs/formats/hashtags/audio/top-posts/recommendation all stay scoped to the
  // user's OWN niche activity — general reference posts (e.g. #reels, #trending)
  // exist only to feed the niche-vs-general `categories` comparison below and
  // must not dilute "your brand's" numbers.
  const nicheRows = rows.filter((r) => scopeOf(r.category) === 'niche');
  const seen = new Set<string>();
  const posts: CleanRow[] = [];
  for (const r of nicheRows) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      posts.push(r);
    }
  }

  const totalEng = posts.reduce((a, r) => a + r.score, 0);
  const kpis = {
    posts: posts.length,
    creators: new Set(posts.filter((r) => r.owner).map((r) => r.owner)).size,
    total_eng: totalEng,
    avg_eng: posts.length ? round1(totalEng / posts.length) : 0,
    hidden_pct: posts.length ? Math.round((100 * posts.filter((r) => r.hidden_likes).length) / posts.length) : 0,
    reels_pct: posts.length ? Math.round((100 * posts.filter((r) => r.is_reel).length) / posts.length) : 0,
  };

  // category rollup uses ALL rows (pre-dedupe), matching the Python original
  const cat = new Map<string, number[]>();
  for (const r of rows) {
    if (!cat.has(r.category)) cat.set(r.category, []);
    cat.get(r.category)!.push(r.score);
  }
  const categories = [...cat.entries()]
    .map(([name, v]) => ({ name, n: v.length, avg: avg(v), total: v.reduce((a, b) => a + b, 0), scope: scopeOf(name) }))
    .sort((a, b) => b.avg - a.avg);

  const fmt = new Map<string, number[]>();
  for (const r of posts) {
    if (!fmt.has(r.type)) fmt.set(r.type, []);
    fmt.get(r.type)!.push(r.score);
  }
  const formats = [...fmt.entries()]
    .map(([name, v]) => ({ name, n: v.length, avg: avg(v) }))
    .sort((a, b) => b.avg - a.avg);

  const tagscore = new Map<string, number[]>();
  for (const r of posts) {
    for (const t of new Set(r.tags)) {
      if (!tagscore.has(t)) tagscore.set(t, []);
      tagscore.get(t)!.push(r.score);
    }
  }
  const hashtags = [...tagscore.entries()]
    .filter(([, v]) => v.length >= 3)
    .map(([tag, v]) => ({ tag, n: v.length, avg: avg(v) }))
    .sort((a, b) => b.avg - a.avg || b.n - a.n)
    .slice(0, 15);

  const audio = new Map<string, { n: number; score: number }>();
  for (const r of posts) {
    if (r.audio_title) {
      const key = `${r.audio_artist || 'Unknown'} — ${r.audio_title}`;
      const entry = audio.get(key) ?? { n: 0, score: 0 };
      entry.n += 1;
      entry.score += r.score;
      audio.set(key, entry);
    }
  }
  const topAudio = [...audio.entries()]
    .map(([track, v]) => ({ track, ...v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const own = new Map<string, { total: number; n: number }>();
  for (const r of posts) {
    if (r.owner) {
      const entry = own.get(r.owner) ?? { total: 0, n: 0 };
      entry.total += r.score;
      entry.n += 1;
      own.set(r.owner, entry);
    }
  }
  const topCreators = [...own.entries()]
    .map(([owner, v]) => ({ owner, ...v }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const topPosts = [...posts].sort((a, b) => b.score - a.score).slice(0, 12);

  // recommendation is drawn from niche categories only — a general reference
  // tag (e.g. #reels) topping the engagement sort shouldn't become "your niche"
  const nicheCategories = categories.filter((c) => c.scope === 'niche');
  const bestCat = (nicheCategories[0] ?? categories[0])?.name ?? '';
  const bestFmt = (formats.find((f) => f.n >= 3) ?? formats[0] ?? { name: '' }).name;
  const recTags = [...new Set(posts.filter((r) => r.category === bestCat).flatMap((r) => r.tags))]
    .sort((a, b) => avg(tagscore.get(b) ?? []) - avg(tagscore.get(a) ?? []))
    .slice(0, 12);
  const hooks = posts
    .filter((r) => r.category === bestCat && r.caption)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((r) => ({ hook: truncateAtWord(r.caption, 140), score: r.score }));

  return {
    source: sourceLabel,
    kpis,
    categories,
    formats,
    hashtags,
    top_audio: topAudio,
    creators: topCreators,
    top_posts: topPosts.map((r) => ({
      url: r.url, owner: r.owner, category: r.category, type: r.type,
      is_reel: r.is_reel, score: r.score, likes: r.likes, comments: r.comments, caption: r.caption,
    })),
    rec: {
      category: bestCat,
      format: bestFmt,
      format_lift: formats.length > 1 ? round1(formats[0].avg / (formats[formats.length - 1].avg || 1)) : 1,
      tags: recTags,
      hooks,
    },
  };
}

export interface WowComparison {
  prev_source: string;
  latest_source: string;
  comparison_type: 'week_over_week' | 'prev_snapshot';
  time_delta_hours: number;
  categories: Array<{ category: string; current_avg: number; prev_avg: number; delta_pct: number }>;
}

/** snapshots must be sorted newest-first; each carries its raw rows. */
export function buildWowComparison(
  snapshots: Array<{ label: string; fetchedAt: Date; rows: TrendPostInput[] }>,
): WowComparison | null {
  if (snapshots.length < 2) return null;
  const latest = snapshots[0];
  const latestMs = latest.fetchedAt.getTime();
  const DAY = 86_400_000;
  let prev = snapshots.slice(1).find((s) => {
    const age = latestMs - s.fetchedAt.getTime();
    return age >= 4 * DAY && age <= 10 * DAY;
  });
  const comparisonType = prev ? 'week_over_week' as const : 'prev_snapshot' as const;
  if (!prev) prev = snapshots[snapshots.length - 1];

  const catAvgs = (rows: TrendPostInput[]): Map<string, number> => {
    const cats = new Map<string, number[]>();
    for (const row of rows) {
      const score = (row.likes ?? 0) + (row.comments ?? 0);
      const key = row.hashtagQueried.trim();
      if (!cats.has(key)) cats.set(key, []);
      cats.get(key)!.push(score);
    }
    return new Map([...cats.entries()].map(([k, v]) => [k, round1(v.reduce((a, b) => a + b, 0) / v.length)]));
  };

  const nowAvgs = catAvgs(latest.rows);
  const prevAvgs = catAvgs(prev.rows);

  const deltas = [...nowAvgs.entries()].map(([category, currentAvg]) => {
    const prevAvg = prevAvgs.get(category) ?? currentAvg;
    const deltaPct = prevAvg ? round1(((currentAvg - prevAvg) / prevAvg) * 100) : 0;
    return { category, current_avg: currentAvg, prev_avg: prevAvg, delta_pct: deltaPct };
  });

  return {
    prev_source: prev.label,
    latest_source: latest.label,
    comparison_type: comparisonType,
    time_delta_hours: round1((latestMs - prev.fetchedAt.getTime()) / 3_600_000),
    categories: deltas.sort((a, b) => b.delta_pct - a.delta_pct),
  };
}
