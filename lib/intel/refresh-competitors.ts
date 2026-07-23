/* Live competitor refresh: scrapes each tracked handle via Apify, appends any
   new posts (deduped by URL) and upserts today's competitorMetrics row. Pure
   accumulation — repeated runs on the same day update, never duplicate.
   Stories volume comes from one batched datavoyantlab stories-scraper run
   covering every active handle up front — if that run fails, stories stay
   untracked (null) for the day rather than faking a 0. */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { competitors, competitorPosts, competitorMetrics, activityLog } from '../db/schema';
import { apifyToken, isApifyQuotaError } from '../scrapers/apify-client';
import { scrapeCompetitor } from '../scrapers/competitors';
import { scrapeStoryCounts } from '../scrapers/stories';

export type CompetitorRefreshResult = {
  scraped: number;
  failed: string[];
  newPosts: number;
  source: 'apify' | 'none';
  error?: string; // set when the run aborted early (e.g. Apify quota exhausted)
};

const today = () => new Date().toISOString().slice(0, 10);

export async function refreshCompetitors(userId: string, force = false): Promise<CompetitorRefreshResult> {
  if (!apifyToken()) return { scraped: 0, failed: [], newPosts: 0, source: 'none' };

  const date = today();
  const activeAll = await db()
    .select()
    .from(competitors)
    .where(and(eq(competitors.userId, userId), eq(competitors.isActive, true)));
  if (activeAll.length === 0) return { scraped: 0, failed: [], newPosts: 0, source: 'apify' };

  // cost guard: one metrics row per competitor per day means a handle already
  // scraped today needs no re-scrape. Skips keep Apify spend bounded (<$25/mo).
  let active = activeAll;
  if (!force) {
    const done = await db()
      .select({ competitorId: competitorMetrics.competitorId })
      .from(competitorMetrics)
      .where(and(inArray(competitorMetrics.competitorId, activeAll.map((c) => c.id)), eq(competitorMetrics.date, date)));
    const doneSet = new Set(done.map((d) => d.competitorId));
    active = activeAll.filter((c) => !doneSet.has(c.id));
  }
  if (active.length === 0) return { scraped: 0, failed: [], newPosts: 0, source: 'apify' };

  const ids = active.map((c) => c.id);
  const existing = await db()
    .select({ competitorId: competitorPosts.competitorId, postUrl: competitorPosts.postUrl })
    .from(competitorPosts)
    .where(inArray(competitorPosts.competitorId, ids));
  const knownUrls = new Set(existing.map((e) => `${e.competitorId}|${e.postUrl}`));

  // one batched call for every active handle's story count; non-fatal — a failure
  // here just leaves stories untracked (null) for today, it doesn't abort the run
  let storyCounts = new Map<string, number>();
  let storiesAvailable = true;
  try {
    storyCounts = await scrapeStoryCounts(active.map((c) => c.handle));
  } catch {
    storiesAvailable = false;
  }

  let scraped = 0;
  let newPosts = 0;
  const failed: string[] = [];

  let abortError: string | undefined;
  for (const comp of active) {
    let profile;
    try {
      profile = await scrapeCompetitor(comp.handle);
    } catch (e) {
      // account-level Apify error (quota/rate limit) hits every handle → stop now
      // and report it instead of silently marking everything "failed".
      if (isApifyQuotaError(e)) { abortError = e.message; break; }
      profile = null;
    }
    if (!profile) { failed.push(comp.handle); continue; }
    scraped++;

    // keep the competitor row's headline stats current
    await db().update(competitors)
      .set({
        followers: profile.followers,
        displayName: comp.displayName ?? profile.displayName,
        updatedAt: new Date(),
      })
      .where(eq(competitors.id, comp.id));

    // append only posts we haven't stored before
    const fresh = profile.posts.filter((p) => !knownUrls.has(`${comp.id}|${p.postUrl}`));
    if (fresh.length) {
      await db().insert(competitorPosts).values(fresh.map((p) => ({
        competitorId: comp.id,
        caption: p.caption,
        likes: p.likes, comments: p.comments, views: p.views, shares: 0,
        hashtags: p.hashtags, theme: p.theme, type: p.type, postUrl: p.postUrl,
        audioTitle: p.audioTitle,
        postedAt: p.postedAt ? new Date(p.postedAt) : null,
      })));
      for (const p of fresh) knownUrls.add(`${comp.id}|${p.postUrl}`);
      newPosts += fresh.length;
    }

    // engagement rate = avg (likes+comments)/followers across scraped posts
    const er = profile.followers > 0 && profile.posts.length
      ? Math.round((profile.posts.reduce((a, p) => a + (p.likes + p.comments), 0) / profile.posts.length / profile.followers) * 10000) / 100
      : 0;
    const postsToday = profile.posts.filter((p) => p.postedAt?.slice(0, 10) === date).length;

    // one metrics row per competitor per day; storiesCount is real when the batched
    // stories run succeeded (0 = genuinely no active stories), null ("not tracked")
    // only when that run itself failed for this refresh
    const storiesCount = storiesAvailable ? (storyCounts.get(comp.handle.toLowerCase()) ?? 0) : null;
    await db().insert(competitorMetrics)
      .values({ competitorId: comp.id, date, followers: profile.followers, postsCount: postsToday, storiesCount, avgEngagementRate: er })
      .onConflictDoUpdate({
        target: [competitorMetrics.competitorId, competitorMetrics.date],
        set: { followers: profile.followers, postsCount: postsToday, ...(storiesAvailable ? { storiesCount } : {}), avgEngagementRate: er },
      });
  }

  if (scraped > 0) {
    await db().insert(activityLog).values({
      userId, kind: 'competitor_refresh',
      title: `Competitor refresh — ${scraped} scraped, ${newPosts} new posts`,
    });
  }

  return { scraped, failed, newPosts, source: 'apify', error: abortError };
}
