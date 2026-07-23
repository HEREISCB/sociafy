/* Single competitor-intelligence engine. Consumed by both the per-competitor
   insights route and the cross-competitor landscape route. Pure + deterministic.
   Hour/day buckets are in IST (India-only product) via a fixed +5:30 offset —
   still machine-independent since India observes no DST. */

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
// shift the instant by +5:30 then read UTC fields = IST wall-clock hour/day
const istHour = (d: Date): number => new Date(+d + IST_OFFSET_MS).getUTCHours();
const istDay = (d: Date): number => new Date(+d + IST_OFFSET_MS).getUTCDay();

export type IntelPost = {
  caption?: string | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  hashtags: string[] | null;
  theme: string | null;
  type: string | null; // reel | carousel | image
  audioTitle: string | null;
  postedAt: Date | string | null;
};

export type IntelMetric = {
  date: string;
  followers: number | null;
  postsCount: number | null;
  storiesCount: number | null;
  avgEngagementRate: number | null;
};

export type HeatCell = { day: number; hour: number; count: number; eng: number };

export type CompetitorIntel = {
  sampleSize: number;
  postsPerWeek: number;
  engagementTrend: number; // % change first-half vs second-half ER
  followerGrowth: number; // % change over metrics window
  bestHours: { hour: number; avgEngagement: number; posts: number }[];
  bestDays: { day: number; avgEngagement: number; posts: number }[];
  heatmap: HeatCell[]; // non-zero cells only
  storiesPerDay: number;
  storiesToday: number;
  storiesTracked: boolean; // false when no metric row ever carried story data
  formatMix: { reel: number; carousel: number; image: number };
  topThemes: { theme: string; posts: number; avgEngagement: number }[];
  hashtagStrategy: { tag: string; uses: number }[];
  topAudios: { title: string; uses: number }[];
  topHooks: string[];
};

const eng = (p: IntelPost) => (p.likes ?? 0) + (p.comments ?? 0);
const toDate = (d: Date | string): Date => (d instanceof Date ? d : new Date(d));

export function buildCompetitorIntel(posts: IntelPost[], metrics: IntelMetric[]): CompetitorIntel {
  const dated = posts.filter((p) => p.postedAt).map((p) => ({ ...p, at: toDate(p.postedAt!) }));

  // need ≥2 dated posts for a meaningful cadence; else the span floors to 1 day
  // and a single post reads as "7/week". Report the raw count instead.
  const spanDays = dated.length >= 2
    ? (Math.max(...dated.map((p) => +p.at)) - Math.min(...dated.map((p) => +p.at))) / DAY_MS
    : 0;
  const postsPerWeek = spanDays >= 1
    ? Math.round((dated.length / spanDays) * 7 * 10) / 10
    : dated.length;

  const half = Math.floor(metrics.length / 2);
  const avgEr = (rows: IntelMetric[]) =>
    rows.length ? rows.reduce((a, m) => a + (m.avgEngagementRate ?? 0), 0) / rows.length : 0;
  const erFirst = avgEr(metrics.slice(0, half));
  const erSecond = avgEr(metrics.slice(half));
  const engagementTrend = erFirst ? Math.round(((erSecond - erFirst) / erFirst) * 1000) / 10 : 0;

  const f0 = metrics[0]?.followers ?? 0;
  const fN = metrics[metrics.length - 1]?.followers ?? 0;
  const followerGrowth = f0 ? Math.round(((fN - f0) / f0) * 1000) / 10 : 0;

  // hour + day + heatmap in one pass
  const hourAgg = new Map<number, { n: number; eng: number }>();
  const dayAgg = new Map<number, { n: number; eng: number }>();
  const heat = new Map<string, HeatCell>();
  for (const p of dated) {
    const h = istHour(p.at);
    const d = istDay(p.at);
    const e = eng(p);
    const hh = hourAgg.get(h) ?? { n: 0, eng: 0 };
    hh.n++; hh.eng += e; hourAgg.set(h, hh);
    const dd = dayAgg.get(d) ?? { n: 0, eng: 0 };
    dd.n++; dd.eng += e; dayAgg.set(d, dd);
    const key = `${d}:${h}`;
    const c = heat.get(key) ?? { day: d, hour: h, count: 0, eng: 0 };
    c.count++; c.eng += e; heat.set(key, c);
  }
  const bestHours = [...hourAgg.entries()]
    .map(([hour, v]) => ({ hour, avgEngagement: Math.round(v.eng / v.n), posts: v.n }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);
  const bestDays = [...dayAgg.entries()]
    .map(([day, v]) => ({ day, avgEngagement: Math.round(v.eng / v.n), posts: v.n }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);

  const storyRows = metrics.filter((m) => (m.storiesCount ?? 0) > 0);
  const storiesPerDay = storyRows.length
    ? Math.round((storyRows.reduce((a, m) => a + (m.storiesCount ?? 0), 0) / storyRows.length) * 10) / 10
    : 0;
  const storiesToday = metrics.length ? metrics[metrics.length - 1].storiesCount ?? 0 : 0;
  const storiesTracked = metrics.some((m) => m.storiesCount != null);

  const formatMix = { reel: 0, carousel: 0, image: 0 };
  for (const p of posts) {
    const t = (p.type ?? '').toLowerCase();
    if (t === 'reel') formatMix.reel++;
    else if (t === 'carousel') formatMix.carousel++;
    else if (t === 'image' || t === 'photo') formatMix.image++;
  }

  const themeScores = new Map<string, { n: number; eng: number }>();
  for (const p of posts) {
    const theme = p.theme ?? 'other';
    const v = themeScores.get(theme) ?? { n: 0, eng: 0 };
    v.n++; v.eng += eng(p); themeScores.set(theme, v);
  }
  const topThemes = [...themeScores.entries()]
    .map(([theme, v]) => ({ theme, posts: v.n, avgEngagement: Math.round(v.eng / v.n) }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);

  const tagScores = new Map<string, number>();
  for (const p of posts) for (const t of p.hashtags ?? []) tagScores.set(t, (tagScores.get(t) ?? 0) + 1);
  const hashtagStrategy = [...tagScores.entries()]
    .map(([tag, uses]) => ({ tag, uses }))
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 10);

  const audioScores = new Map<string, number>();
  for (const p of posts) if (p.audioTitle) audioScores.set(p.audioTitle, (audioScores.get(p.audioTitle) ?? 0) + 1);
  const topAudios = [...audioScores.entries()]
    .map(([title, uses]) => ({ title, uses }))
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 5);

  const topHooks = [...posts]
    .filter((p) => p.caption)
    .sort((a, b) => eng(b) - eng(a))
    .slice(0, 3)
    .map((p) => p.caption!.split('\n')[0].slice(0, 80).trim())
    .filter(Boolean);

  return {
    sampleSize: posts.length, postsPerWeek, engagementTrend, followerGrowth,
    bestHours, bestDays, heatmap: [...heat.values()],
    storiesPerDay, storiesToday, storiesTracked, formatMix,
    topThemes, hashtagStrategy, topAudios, topHooks,
  };
}
