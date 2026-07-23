import { NextRequest } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { withUser, jsonOk, jsonError } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { apifyToken } from '../../../../lib/scrapers/apify-client';
import { db } from '../../../../lib/db';
import { competitors, competitorMetrics, connectedAccounts, trendSnapshots, trendPosts, trendSettings, activityLog } from '../../../../lib/db/schema';
import { discoverCompetitors } from '../../../../lib/intel/discover-competitors';
import { refreshTrends } from '../../../../lib/taccv/refresh';
import { refreshCompetitors } from '../../../../lib/intel/refresh-competitors';
import { isApifyQuotaError } from '../../../../lib/scrapers/apify-client';
import { checkQuota, recordUsage } from '../../../../lib/usage';

export const dynamic = 'force-dynamic';

const MAX_ACTIVE = 10;

// Auto-discover niche competitors: mine the owners of posts we already scraped
// under the tracked niche hashtags, keep the India-affinity ones, add the top
// candidates and scrape them inline so landscape/insights are ready.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.database()) return jsonError('database not configured', 503);
    if (!apifyToken()) return jsonError('APIFY_TOKEN not configured — needed to scrape live niche data', 400);
    await checkQuota(user.id, 'analysis');

    // source = this user's live (apify) trend snapshots; scrape one if none exist yet
    let snaps = await db()
      .select({ id: trendSnapshots.id })
      .from(trendSnapshots)
      .where(and(eq(trendSnapshots.userId, user.id), eq(trendSnapshots.source, 'apify'), eq(trendSnapshots.platform, 'instagram')))
      .orderBy(desc(trendSnapshots.fetchedAt))
      .limit(6);
    if (snaps.length === 0) {
      let r;
      try {
        r = await refreshTrends(user.id, true);
      } catch (e) {
        if (isApifyQuotaError(e)) return jsonError(`Apify limit reached — ${e.message}`, 429);
        throw e;
      }
      if ('reason' in r && r.reason === 'apify_error') {
        return jsonError(`Apify limit reached — ${r.error}`, 429);
      }
      if ('reason' in r && r.reason === 'no_data') {
        return jsonError('no niche data — set tracked hashtags in Trends first', 400);
      }
      snaps = await db()
        .select({ id: trendSnapshots.id })
        .from(trendSnapshots)
        .where(and(eq(trendSnapshots.userId, user.id), eq(trendSnapshots.source, 'apify'), eq(trendSnapshots.platform, 'instagram')))
        .orderBy(desc(trendSnapshots.fetchedAt))
        .limit(6);
    }
    if (snaps.length === 0) return jsonOk({ added: [], candidates: [], reason: 'no_trend_data' });

    const posts = await db()
      .select({
        owner: trendPosts.owner, caption: trendPosts.caption, postHashtags: trendPosts.postHashtags,
        likes: trendPosts.likes, comments: trendPosts.comments, views: trendPosts.views,
        ownerFollowers: trendPosts.ownerFollowers,
      })
      .from(trendPosts)
      .where(inArray(trendPosts.snapshotId, snaps.map((s) => s.id)));

    // never suggest handles we already track or the user's own connected accounts
    const existing = await db()
      .select({ handle: competitors.handle, isActive: competitors.isActive })
      .from(competitors)
      .where(eq(competitors.userId, user.id));
    const accts = await db()
      .select({ handle: connectedAccounts.handle })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, user.id));
    const [tset] = await db().select({ selfHandle: trendSettings.selfHandle }).from(trendSettings).where(eq(trendSettings.userId, user.id)).limit(1);
    const exclude = [...existing.map((e) => e.handle), ...accts.map((a) => a.handle ?? ''), tset?.selfHandle ?? ''].filter(Boolean);

    const openSlots = MAX_ACTIVE - existing.filter((e) => e.isActive).length;
    const candidates = discoverCompetitors(posts, { exclude, limit: Math.max(openSlots, 0) });
    if (openSlots <= 0) {
      return jsonOk({ added: [], candidates, reason: 'max_active', limit: MAX_ACTIVE });
    }

    const inserted: Array<{ id: string; handle: string }> = [];
    for (const c of candidates) {
      const [row] = await db().insert(competitors)
        .values({
          userId: user.id, platform: 'instagram', handle: c.handle,
          notes: `auto-discovered · av ${c.avScore} · brand ${c.brandScore} · lux ${c.luxScore}`,
        })
        .onConflictDoNothing()
        .returning({ id: competitors.id, handle: competitors.handle });
      if (row) inserted.push(row);
    }

    // scrape the freshly added handles now (cost guard skips any already done today)
    const scraped = inserted.length
      ? await refreshCompetitors(user.id)
      : { scraped: 0, failed: [] as string[], newPosts: 0, source: 'apify' as const, error: undefined as string | undefined };

    // drop any just-added handle that produced no metrics row (scrape failed /
    // unresolvable / quota) so discovery never leaves dead 0-follower cards
    const survivors: string[] = [];
    if (inserted.length) {
      const withData = await db()
        .select({ competitorId: competitorMetrics.competitorId })
        .from(competitorMetrics)
        .where(inArray(competitorMetrics.competitorId, inserted.map((i) => i.id)));
      const haveData = new Set(withData.map((w) => w.competitorId));
      const dead = inserted.filter((i) => !haveData.has(i.id));
      if (dead.length) {
        await db().delete(competitors).where(inArray(competitors.id, dead.map((d) => d.id)));
      }
      for (const i of inserted) if (haveData.has(i.id)) survivors.push(i.handle);
    }

    if (survivors.length) {
      await db().insert(activityLog).values({
        userId: user.id, kind: 'competitor_discovered',
        title: `Auto-discovered ${survivors.length} niche competitors`,
      });
    }
    if (scraped.scraped > 0) await recordUsage(user.id, 'analysis', 1, { feature: 'competitor_discover' });

    return jsonOk({
      added: survivors, candidates, scraped,
      error: scraped.error,
      reason: !survivors.length && scraped.error ? 'apify_error' : undefined,
    });
  }, req);
}
