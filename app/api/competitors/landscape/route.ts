import { asc, eq, inArray } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { db } from '../../../../lib/db';
import { competitors, competitorPosts, competitorMetrics, trendSettings } from '../../../../lib/db/schema';
import { buildCompetitorIntel } from '../../../../lib/intel/competitor-intel';
import { strategizeCompetitors } from '../../../../lib/intel/strategist';

export const dynamic = 'force-dynamic';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const empty = { competitors: [], aggregate: null, strategy: null, niche: null };
// matches the dashboard's hourLabel() so the LLM sees the same "11am"/"6pm" format the UI renders
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;

export async function GET() {
  return withUser(async (user) => {
    if (isStubMode.database()) return empty;

    const comps = await db()
      .select()
      .from(competitors)
      .where(eq(competitors.userId, user.id));
    const active = comps.filter((c) => c.isActive);
    if (active.length === 0) return empty;

    const ids = active.map((c) => c.id);
    const posts = await db().select().from(competitorPosts).where(inArray(competitorPosts.competitorId, ids));
    const metrics = await db()
      .select()
      .from(competitorMetrics)
      .where(inArray(competitorMetrics.competitorId, ids))
      .orderBy(asc(competitorMetrics.date));

    const postsBy = new Map<string, typeof posts>();
    const metricsBy = new Map<string, typeof metrics>();
    for (const p of posts) (postsBy.get(p.competitorId) ?? postsBy.set(p.competitorId, []).get(p.competitorId)!).push(p);
    for (const m of metrics) (metricsBy.get(m.competitorId) ?? metricsBy.set(m.competitorId, []).get(m.competitorId)!).push(m);

    const cards = active.map((c) => {
      const intel = buildCompetitorIntel(postsBy.get(c.id) ?? [], metricsBy.get(c.id) ?? []);
      return {
        id: c.id, handle: c.handle, displayName: c.displayName,
        followers: c.followers,
        postsPerWeek: intel.postsPerWeek,
        storiesPerDay: intel.storiesPerDay,
        engagementTrend: intel.engagementTrend,
        followerGrowth: intel.followerGrowth,
        topBestHourUTC: intel.bestHours[0]?.hour ?? null,
        topTheme: intel.topThemes[0]?.theme ?? null,
        formatMix: intel.formatMix,
      };
    }).sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));

    // aggregate hour histogram across all competitor posts -> busiest vs white-space.
    // Buckets are IST (India-only product): shift the instant +5:30, read UTC hour.
    const IST_OFFSET_MS = 5.5 * 3_600_000;
    const hourHist = new Array(24).fill(0);
    for (const p of posts) if (p.postedAt) hourHist[new Date(+new Date(p.postedAt as unknown as string) + IST_OFFSET_MS).getUTCHours()]++;
    const dayWindow = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]; // realistic posting hours (IST)
    // pick top-3 by count, then present chronologically (readable time order)
    const busiestHoursIST = hourHist
      .map((count, hour) => ({ hour, count }))
      .filter((h) => h.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .sort((a, b) => a.hour - b.hour);
    const whiteSpaceHoursIST = dayWindow
      .map((hour) => ({ hour, count: hourHist[hour] }))
      .sort((a, b) => a.count - b.count)
      .slice(0, 3)
      .sort((a, b) => a.hour - b.hour);

    const avgStoriesPerDay = Math.round((cards.reduce((a, c) => a + c.storiesPerDay, 0) / cards.length) * 10) / 10;
    const avgPostsPerWeek = Math.round((cards.reduce((a, c) => a + c.postsPerWeek, 0) / cards.length) * 10) / 10;

    const [settings] = await db().select().from(trendSettings).where(eq(trendSettings.userId, user.id)).limit(1);
    const niche = settings?.niche ?? null;

    const themeCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    for (const p of posts) {
      if (p.theme) themeCounts.set(p.theme, (themeCounts.get(p.theme) ?? 0) + 1);
      for (const t of p.hashtags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

    const aggregate = {
      count: active.length,
      avgPostsPerWeek, avgStoriesPerDay,
      busiestHoursIST, whiteSpaceHoursIST,
      commonThemes: top(themeCounts, 5),
      commonHashtags: top(tagCounts, 8),
    };

    // LLM gets labeled, unambiguous hour semantics — NOT the raw {hour,count} the
    // UI uses — so it can't mistake "white space" (opportunity, low competition)
    // for "low engagement, avoid". Feeding it the same numbers with clear meaning
    // is what stops the Do/Don't list from contradicting the White-space callout.
    const strategy = await strategizeCompetitors(
      {
        avgPostsPerWeek, avgStoriesPerDay,
        saturatedHoursIST: busiestHoursIST.map((h) => hourLabel(h.hour)),
        opportunityHoursIST: whiteSpaceHoursIST.map((h) => hourLabel(h.hour)),
        commonThemes: aggregate.commonThemes, commonHashtags: aggregate.commonHashtags,
        competitorHandles: cards.map((c) => c.handle),
      },
      niche,
    );

    return { competitors: cards, aggregate, strategy, niche, dow: DOW };
  });
}
