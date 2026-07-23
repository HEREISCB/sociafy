import { NextRequest } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { withUser, jsonOk, jsonError } from '../../../../../lib/api';
import { db } from '../../../../../lib/db';
import { competitors, competitorPosts, competitorMetrics, trendSettings } from '../../../../../lib/db/schema';
import { checkQuota, recordUsage } from '../../../../../lib/usage';
import { buildCompetitorIntel } from '../../../../../lib/intel/competitor-intel';
import { strategizeCompetitors } from '../../../../../lib/intel/strategist';

const HOUR_LABELS = ['12am', '1am', '2am', '3am', '4am', '5am', '6am', '7am', '8am', '9am', '10am', '11am',
  '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm', '10pm', '11pm'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await params;
    const [competitor] = await db()
      .select()
      .from(competitors)
      .where(and(eq(competitors.id, id), eq(competitors.userId, user.id)))
      .limit(1);
    if (!competitor) return jsonError('not found', 404);

    const reAnalyze = req.nextUrl.searchParams.get('analyze') === '1';
    if (reAnalyze) {
      await checkQuota(user.id, 'analysis');
      await recordUsage(user.id, 'analysis', 1, { feature: 'competitor_insights', handle: competitor.handle });
    }

    const posts = await db().select().from(competitorPosts).where(eq(competitorPosts.competitorId, id));
    const metrics = await db()
      .select()
      .from(competitorMetrics)
      .where(eq(competitorMetrics.competitorId, id))
      .orderBy(asc(competitorMetrics.date));

    const intel = buildCompetitorIntel(posts, metrics);

    // labeled views for the UI
    const bestTimes = intel.bestHours.slice(0, 3).map((h) => ({ hour: HOUR_LABELS[h.hour], avgEngagement: h.avgEngagement, posts: h.posts }));
    const bestDays = intel.bestDays.slice(0, 3).map((d) => ({ day: DOW[d.day], avgEngagement: d.avgEngagement, posts: d.posts }));

    let strategy = null;
    if (reAnalyze) {
      const [settings] = await db().select().from(trendSettings).where(eq(trendSettings.userId, user.id)).limit(1);
      strategy = await strategizeCompetitors(
        {
          handle: competitor.handle,
          followers: competitor.followers,
          postsPerWeek: intel.postsPerWeek,
          storiesPerDay: intel.storiesPerDay,
          formatMix: intel.formatMix,
          bestHoursIST: intel.bestHours.slice(0, 3),
          bestDays: intel.bestDays.slice(0, 3).map((d) => DOW[d.day]),
          topThemes: intel.topThemes.slice(0, 4),
          topHashtags: intel.hashtagStrategy.slice(0, 6).map((h) => h.tag),
          engagementTrend: intel.engagementTrend,
          followerGrowth: intel.followerGrowth,
        },
        settings?.niche ?? null,
      );
    }

    const latestEngagementRate = metrics.length ? metrics[metrics.length - 1].avgEngagementRate ?? 0 : 0;

    return jsonOk({
      competitor: { id: competitor.id, handle: competitor.handle, displayName: competitor.displayName, followers: competitor.followers },
      latestEngagementRate,
      ...intel,
      bestTimes,
      bestDaysLabeled: bestDays,
      strategy,
    });
  }, req);
}
