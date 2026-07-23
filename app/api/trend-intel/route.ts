import { and, desc, eq, inArray } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { isStubMode } from '../../../lib/env';
import { db } from '../../../lib/db';
import { trendSnapshots, trendPosts, trendSettings, competitors, competitorPosts, competitorMetrics } from '../../../lib/db/schema';
import { buildTrendData, buildWowComparison, type TrendPostInput } from '../../../lib/taccv/trend-analysis';
import { generateSummary } from '../../../lib/taccv/ai-summary';
import { normalizeHashtag } from '../../../lib/text/hashtag';
import { buildGeneralTrends } from '../../../lib/intel/general-trends';
import { strategizeGeneral, buildBrandStrategy } from '../../../lib/intel/strategist';
import { buildCompetitorIntel, type IntelPost, type IntelMetric } from '../../../lib/intel/competitor-intel';

export const dynamic = 'force-dynamic';

export async function GET() {
  return withUser(async (user) => {
    if (isStubMode.database()) return jsonError('no trends data yet', 404);

    const snaps = await db()
      .select()
      .from(trendSnapshots)
      .where(and(eq(trendSnapshots.userId, user.id), eq(trendSnapshots.platform, 'instagram')))
      .orderBy(desc(trendSnapshots.fetchedAt))
      .limit(10);
    if (snaps.length === 0) return jsonError('no trends data yet', 404);

    const allRows = await db()
      .select()
      .from(trendPosts)
      .where(inArray(trendPosts.snapshotId, snaps.map((s) => s.id)));
    const rowsBySnap = new Map<string, TrendPostInput[]>();
    for (const r of allRows) {
      if (!rowsBySnap.has(r.snapshotId)) rowsBySnap.set(r.snapshotId, []);
      rowsBySnap.get(r.snapshotId)!.push(r);
    }

    const [settings] = await db().select().from(trendSettings).where(eq(trendSettings.userId, user.id)).limit(1);
    const trackedHashtags = settings?.trackedHashtags ?? [];
    const latest = snaps[0];
    const data = buildTrendData(
      rowsBySnap.get(latest.id) ?? [],
      latest.label ?? latest.id,
      trackedHashtags,
      trackedHashtags,
    );
    if (!data) return jsonError('no trends data yet', 404);

    // momentum table is "hashtags you track" by design — strip the general
    // reference tags (#reels/#trending) that refreshTrends scrapes alongside
    // them, so they don't show up mislabeled as something the user tracks
    const nicheLower = new Set(trackedHashtags.map(normalizeHashtag));
    const wow = buildWowComparison(
      snaps.map((s) => ({
        label: s.label ?? s.id, fetchedAt: s.fetchedAt,
        rows: nicheLower.size
          ? (rowsBySnap.get(s.id) ?? []).filter((r) => nicheLower.has(normalizeHashtag(r.hashtagQueried)))
          : (rowsBySnap.get(s.id) ?? []),
      })),
    );
    const summary = await generateSummary(data, settings?.niche);

    // audioTitle -> the single highest-engagement post using it, for "trending audio -> IG reel"
    // links on top_audio. Scoped to the same niche rows buildTrendData used for top_audio itself
    // (general-tag posts sharing a track name shouldn't win the link for a niche-only stat),
    // keyed by the same "artist — title" format buildTrendData uses for `track`.
    const nicheOnlyRows = nicheLower.size
      ? (rowsBySnap.get(latest.id) ?? []).filter((r) => nicheLower.has(normalizeHashtag(r.hashtagQueried)))
      : (rowsBySnap.get(latest.id) ?? []);
    const audioTopPost = new Map<string, { url: string; score: number }>();
    for (const r of nicheOnlyRows) {
      if (!r.audioTitle) continue;
      const key = `${r.audioArtist || 'Unknown'} — ${r.audioTitle}`;
      const score = (r.likes ?? 0) + (r.comments ?? 0);
      const best = audioTopPost.get(key);
      if (!best || score > best.score) audioTopPost.set(key, { url: r.postUrl, score });
    }
    const topAudioWithUrl = data.top_audio.map((a) => ({ ...a, topPostUrl: audioTopPost.get(a.track)?.url ?? null }));

    // general buckets: buildGeneralTrends itself ignores any row whose queried
    // tag isn't in GENERAL_CATALOG, so the full latest-snapshot row set (niche + general) works as-is.
    const buckets = buildGeneralTrends(rowsBySnap.get(latest.id) ?? []);

    // lightweight competitor-landscape rollup for buildBrandStrategy's prompt/fallback —
    // reuses the same buildCompetitorIntel engine as the landscape route, not a new one.
    const activeCompetitors = await db()
      .select()
      .from(competitors)
      .where(and(eq(competitors.userId, user.id), eq(competitors.isActive, true)));
    let competitorLandscape: Record<string, unknown> | null = null;
    if (activeCompetitors.length) {
      const ids = activeCompetitors.map((c) => c.id);
      const compPosts = await db().select().from(competitorPosts).where(inArray(competitorPosts.competitorId, ids));
      const compMetrics = await db().select().from(competitorMetrics).where(inArray(competitorMetrics.competitorId, ids));
      const postsBy = new Map<string, IntelPost[]>();
      const metricsBy = new Map<string, IntelMetric[]>();
      for (const p of compPosts) (postsBy.get(p.competitorId) ?? postsBy.set(p.competitorId, []).get(p.competitorId)!).push(p);
      for (const m of compMetrics) (metricsBy.get(m.competitorId) ?? metricsBy.set(m.competitorId, []).get(m.competitorId)!).push(m);
      const intels = activeCompetitors.map((c) => buildCompetitorIntel(postsBy.get(c.id) ?? [], metricsBy.get(c.id) ?? []));
      const themeCounts = new Map<string, number>();
      const tagCounts = new Map<string, number>();
      for (const p of compPosts) {
        if (p.theme) themeCounts.set(p.theme, (themeCounts.get(p.theme) ?? 0) + 1);
        for (const t of p.hashtags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
      const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
      competitorLandscape = {
        count: activeCompetitors.length,
        avgPostsPerWeek: Math.round((intels.reduce((a, i) => a + i.postsPerWeek, 0) / intels.length) * 10) / 10,
        avgStoriesPerDay: Math.round((intels.reduce((a, i) => a + i.storiesPerDay, 0) / intels.length) * 10) / 10,
        commonThemes: top(themeCounts, 5),
        commonHashtags: top(tagCounts, 8),
      };
    }

    const [general, strategy] = await Promise.all([
      strategizeGeneral(buckets, settings?.niche ?? null),
      buildBrandStrategy({ nicheRec: data.rec, generalBuckets: buckets, competitorLandscape }, settings?.niche ?? null),
    ]);

    return {
      ...data, top_audio: topAudioWithUrl, summary, wow, general, strategy,
      settings: {
        hashtags: settings?.trackedHashtags ?? [], niche: settings?.niche ?? null,
        companyDescription: settings?.companyDescription ?? null, selfHandle: settings?.selfHandle ?? null,
      },
    };
  });
}
