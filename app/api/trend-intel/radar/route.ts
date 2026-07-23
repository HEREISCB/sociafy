import { and, asc, eq, inArray } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { db } from '../../../../lib/db';
import { trendSnapshots, trendPosts, trendSettings } from '../../../../lib/db/schema';
import { buildForecasts, watchlist, nicheFitBase, normTag, type ForecastRow } from '../../../../lib/intel/forecast';
import { strategizeTrends } from '../../../../lib/intel/strategist';
import { normalizeHashtag } from '../../../../lib/text/hashtag';

export const dynamic = 'force-dynamic';

const HORIZON_HOURS = 48;

export async function GET() {
  return withUser(async (user) => {
    if (isStubMode.database()) return jsonError('no trends data yet', 404);

    const snaps = await db()
      .select()
      .from(trendSnapshots)
      .where(and(eq(trendSnapshots.userId, user.id), eq(trendSnapshots.platform, 'instagram')))
      .orderBy(asc(trendSnapshots.fetchedAt))
      .limit(12);
    if (snaps.length < 3) return jsonError('need at least 3 snapshots to forecast trends', 404);

    const [settings] = await db().select().from(trendSettings).where(eq(trendSettings.userId, user.id)).limit(1);
    const nicheTags = settings?.trackedHashtags ?? [];
    const niche = settings?.niche ?? null;
    const nicheLower = new Set(nicheTags.map(normalizeHashtag));

    // radar/watchlist stay 100% niche-scoped: exclude every post whose QUERY tag
    // was a general reference tag (#reels/#trending — see refresh.ts), not just
    // the tag itself. A generic viral reel's own unrelated co-hashtags (#fyp,
    // #comedy, ...) would otherwise leak into the forecast as noise entities —
    // dropping the whole post at the source is the only way to keep that out.
    const rawRows = await db()
      .select()
      .from(trendPosts)
      .where(inArray(trendPosts.snapshotId, snaps.map((s) => s.id)));
    const allRows = nicheLower.size
      ? rawRows.filter((r) => nicheLower.has(normalizeHashtag(r.hashtagQueried)))
      : rawRows;
    const rowsBySnap = new Map<string, ForecastRow[]>();
    for (const r of allRows) {
      if (!rowsBySnap.has(r.snapshotId)) rowsBySnap.set(r.snapshotId, []);
      rowsBySnap.get(r.snapshotId)!.push(r);
    }

    const forecasts = buildForecasts(
      snaps.map((s) => ({ fetchedAt: s.fetchedAt, rows: rowsBySnap.get(s.id) ?? [] })),
      { horizonHours: HORIZON_HOURS },
    );
    for (const f of forecasts) f.fitBase = nicheFitBase(f.entity, allRows, nicheTags, niche);

    const wl = watchlist(forecasts, HORIZON_HOURS);
    const verdicts = await strategizeTrends(wl.filter((f) => f.kind === 'hashtag').slice(0, 8), niche);

    const stageRank = { peaking: 0, rising: 1, emerging: 2, declining: 3 };
    const radar = forecasts
      .filter((f) => f.kind === 'hashtag')
      .sort((a, b) =>
        stageRank[a.stage] - stageRank[b.stage] ||
        (b.fitBase ?? 0) - (a.fitBase ?? 0) ||
        b.confidence - a.confidence)
      .slice(0, 12);

    const audios = forecasts
      .filter((f) => f.kind === 'audio')
      .sort((a, b) => b.strengthNow - a.strengthNow)
      .slice(0, 8);

    // audioTitle -> the single highest-engagement post using it, for "trending audio -> IG reel" links.
    // Keyed by normTag so it matches forecast.ts's own audio entity key exactly.
    const audioTopPost = new Map<string, { url: string; score: number }>();
    for (const r of allRows) {
      if (!r.audioTitle) continue;
      const key = normTag(r.audioTitle);
      const score = (r.likes ?? 0) + (r.comments ?? 0);
      const best = audioTopPost.get(key);
      if (!best || score > best.score) audioTopPost.set(key, { url: r.postUrl, score });
    }

    const enrich = (f: (typeof forecasts)[number]) => {
      const v = verdicts.get(f.entity);
      return {
        entity: f.entity, kind: f.kind, stage: f.stage,
        velocityPct: f.velocityPct, peakAt: f.peakAt, hoursToPeak: f.hoursToPeak,
        confidence: f.confidence, series: f.series,
        fit: v?.fit ?? f.fitBase ?? 0,
        verdict: v?.verdict ?? null,
        tip: v?.tip || null,
      };
    };

    return {
      generatedAt: new Date().toISOString(),
      horizonHours: HORIZON_HOURS,
      niche,
      watchlist: wl.filter((f) => f.kind === 'hashtag').slice(0, 8).map(enrich),
      radar: radar.map(enrich),
      audios: audios.map((f) => ({
        title: f.entity, stage: f.stage, velocityPct: f.velocityPct,
        hoursToPeak: f.hoursToPeak, confidence: f.confidence, series: f.series,
        topPostUrl: audioTopPost.get(normTag(f.entity))?.url ?? null,
      })),
    };
  });
}
