/* Live LinkedIn company refresh: scrapes each tracked company via Apify, keeps
   the row's firmographics current and upserts today's linkedinMetrics row.
   Cost-guarded like refresh-competitors: a company already scraped today is
   skipped (one metrics row/company/day), so re-runs and the daily cron are free. */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { linkedinCompanies, linkedinMetrics, activityLog } from '../db/schema';
import { apifyToken, isApifyQuotaError } from '../scrapers/apify-client';
import { scrapeLinkedInCompany } from '../scrapers/linkedin';

export type LinkedInRefreshResult = {
  scraped: number;
  failed: string[];
  source: 'apify' | 'none';
  error?: string;
};

const today = () => new Date().toISOString().slice(0, 10);

export async function refreshLinkedIn(userId: string, force = false): Promise<LinkedInRefreshResult> {
  if (!apifyToken()) return { scraped: 0, failed: [], source: 'none' };

  const date = today();
  const activeAll = await db()
    .select()
    .from(linkedinCompanies)
    .where(and(eq(linkedinCompanies.userId, userId), eq(linkedinCompanies.isActive, true)));
  if (activeAll.length === 0) return { scraped: 0, failed: [], source: 'apify' };

  let active = activeAll;
  if (!force) {
    const done = await db()
      .select({ companyId: linkedinMetrics.companyId })
      .from(linkedinMetrics)
      .where(and(inArray(linkedinMetrics.companyId, activeAll.map((c) => c.id)), eq(linkedinMetrics.date, date)));
    const doneSet = new Set(done.map((d) => d.companyId));
    active = activeAll.filter((c) => !doneSet.has(c.id));
  }
  if (active.length === 0) return { scraped: 0, failed: [], source: 'apify' };

  let scraped = 0;
  const failed: string[] = [];
  let abortError: string | undefined;

  for (const comp of active) {
    let profile;
    try {
      profile = await scrapeLinkedInCompany(comp.url || comp.slug);
    } catch (e) {
      // account-level Apify error hits every run → stop and surface it
      if (isApifyQuotaError(e)) { abortError = e.message; break; }
      profile = null;
    }
    if (!profile) { failed.push(comp.slug); continue; }
    scraped++;

    await db().update(linkedinCompanies)
      .set({
        name: profile.name ?? comp.name,
        industry: profile.industry ?? comp.industry,
        website: profile.website ?? comp.website,
        headquarters: profile.headquarters ?? comp.headquarters,
        foundedYear: profile.foundedYear ?? comp.foundedYear,
        description: profile.description ?? comp.description,
        specialities: profile.specialities.length ? profile.specialities : comp.specialities,
        logoUrl: profile.logoUrl ?? comp.logoUrl,
        followers: profile.followers,
        employees: profile.employees,
        updatedAt: new Date(),
      })
      .where(eq(linkedinCompanies.id, comp.id));

    await db().insert(linkedinMetrics)
      .values({ companyId: comp.id, date, followers: profile.followers, employees: profile.employees })
      .onConflictDoUpdate({
        target: [linkedinMetrics.companyId, linkedinMetrics.date],
        set: { followers: profile.followers, employees: profile.employees },
      });
  }

  if (scraped > 0) {
    await db().insert(activityLog).values({
      userId, kind: 'linkedin_refresh',
      title: `LinkedIn refresh — ${scraped} compan${scraped === 1 ? 'y' : 'ies'} updated`,
    });
  }

  return { scraped, failed, source: 'apify', error: abortError };
}
