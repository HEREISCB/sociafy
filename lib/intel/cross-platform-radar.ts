/* DB orchestration for the cross-platform radar: loads TikTok/YouTube/Instagram
   snapshots, runs them through the pure forecast + cross-platform engines, and
   (for the cron) logs high-alert opportunities to activityLog so they surface
   in the notification bell. Shared by the API route (read) and the cron (read +
   alert) so there's exactly one place this logic lives. */
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db';
import { trendSnapshots, trendPosts, trendSettings, activityLog, type TrendPlatform } from '../db/schema';
import { buildForecasts, type ForecastRow } from './forecast';
import { crossPlatformOpportunities, instagramEntitySet, type CrossPlatformOpportunity, HIGH_ALERT_HOURS } from './cross-platform';
import { strategizeTrends } from './strategist';

const SOURCE_PLATFORMS: TrendPlatform[] = ['tiktok', 'youtube'];

async function loadPlatformRows(userId: string, platform: TrendPlatform, limit = 12) {
  const snaps = await db()
    .select()
    .from(trendSnapshots)
    .where(and(eq(trendSnapshots.userId, userId), eq(trendSnapshots.platform, platform)))
    .orderBy(asc(trendSnapshots.fetchedAt))
    .limit(limit);
  if (snaps.length === 0) return { snaps, rows: [] };
  const rows = await db().select().from(trendPosts).where(inArray(trendPosts.snapshotId, snaps.map((s) => s.id)));
  return { snaps, rows };
}

export type CrossPlatformRadar = {
  opportunities: Array<CrossPlatformOpportunity & { verdict: 'go' | 'watch' | 'skip' | null; tip: string | null }>;
  highAlertCount: number;
};

export async function buildCrossPlatformRadar(userId: string): Promise<CrossPlatformRadar> {
  const [settings] = await db().select().from(trendSettings).where(eq(trendSettings.userId, userId)).limit(1);
  const nicheTags = settings?.trackedHashtags ?? [];
  const niche = settings?.niche ?? null;

  const { rows: igRows } = await loadPlatformRows(userId, 'instagram');
  const instagramEntities = instagramEntitySet(igRows);

  const sources = [];
  for (const platform of SOURCE_PLATFORMS) {
    const { snaps, rows } = await loadPlatformRows(userId, platform);
    if (snaps.length < 3) continue; // forecast engine needs >=3 points
    const rowsBySnap = new Map<string, ForecastRow[]>();
    for (const r of rows) {
      if (!rowsBySnap.has(r.snapshotId)) rowsBySnap.set(r.snapshotId, []);
      rowsBySnap.get(r.snapshotId)!.push(r);
    }
    const forecasts = buildForecasts(snaps.map((s) => ({ fetchedAt: s.fetchedAt, rows: rowsBySnap.get(s.id) ?? [] })));
    sources.push({ platform, forecasts, allRows: rows });
  }

  const opportunities = crossPlatformOpportunities(sources, nicheTags, niche, instagramEntities);
  const verdicts = await strategizeTrends(opportunities.slice(0, 8), niche);

  return {
    opportunities: opportunities.map((o) => ({
      ...o,
      verdict: verdicts.get(o.entity)?.verdict ?? null,
      tip: verdicts.get(o.entity)?.tip || null,
    })),
    highAlertCount: opportunities.filter((o) => o.highAlert).length,
  };
}

/** Cron-only: push a notification-bell activityLog row for each new high-alert
    opportunity. Deduped against the last 24h of the same title so re-running the
    cron every 2 days doesn't spam the bell with the same entity. */
export async function logHighAlerts(userId: string, radar: CrossPlatformRadar): Promise<number> {
  const alerts = radar.opportunities.filter((o) => o.highAlert);
  if (alerts.length === 0) return 0;

  const since = new Date(Date.now() - 24 * 3_600_000);
  const recent = await db()
    .select({ title: activityLog.title })
    .from(activityLog)
    .where(and(eq(activityLog.userId, userId), eq(activityLog.kind, 'trend_high_alert'), gte(activityLog.createdAt, since)));
  const recentTitles = new Set(recent.map((r) => r.title));

  let logged = 0;
  for (const o of alerts) {
    const window = o.hoursToPeak !== null ? `${Math.max(0, o.hoursToPeak)}h` : 'soon';
    const title = `⚡ Act now: "${o.entity}" peaking on ${o.platform} in ${window} — not yet on your Instagram`;
    if (recentTitles.has(title)) continue;
    await db().insert(activityLog).values({ userId, kind: 'trend_high_alert', title });
    logged++;
  }
  return logged;
}

export { HIGH_ALERT_HOURS };
