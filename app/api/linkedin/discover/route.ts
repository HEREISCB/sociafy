import { NextRequest } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { withUser, jsonOk, jsonError } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { apifyToken, isApifyQuotaError } from '../../../../lib/scrapers/apify-client';
import { db } from '../../../../lib/db';
import { linkedinCompanies, linkedinMetrics, activityLog } from '../../../../lib/db/schema';
import { searchLinkedInCompanies } from '../../../../lib/scrapers/linkedin';
import { descriptionToKeyword, rankLinkedInHits } from '../../../../lib/intel/discover-linkedin';
import { refreshLinkedIn } from '../../../../lib/intel/refresh-linkedin';
import { checkQuota, recordUsage } from '../../../../lib/usage';

export const dynamic = 'force-dynamic';

const MAX_ACTIVE = 10;

// Auto-discover LinkedIn competitors: derive a search keyword from the company
// description, search LinkedIn companies for it, rank by follower size, add the
// top open-slot candidates and scrape them inline so cards populate.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.database()) return jsonError('database not configured', 503);
    if (!apifyToken()) return jsonError('APIFY_TOKEN not configured — needed to search LinkedIn', 400);
    await checkQuota(user.id, 'analysis');

    const body = await req.json().catch(() => ({}));
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const explicit = typeof body.keyword === 'string' ? body.keyword.trim() : '';
    const keyword = explicit || descriptionToKeyword(description);
    if (!keyword) return jsonError('company description or keyword required', 400);

    const existing = await db()
      .select({ slug: linkedinCompanies.slug, isActive: linkedinCompanies.isActive })
      .from(linkedinCompanies)
      .where(eq(linkedinCompanies.userId, user.id));
    const openSlots = MAX_ACTIVE - existing.filter((e) => e.isActive).length;
    if (openSlots <= 0) return jsonOk({ added: [], candidates: [], keyword, reason: 'max_active', limit: MAX_ACTIVE });

    let hits;
    try {
      hits = await searchLinkedInCompanies(keyword, { limit: 30 });
    } catch (e) {
      if (isApifyQuotaError(e)) return jsonError(`Apify limit reached — ${e.message}`, 429);
      throw e;
    }
    const candidates = rankLinkedInHits(hits, { exclude: existing.map((e) => e.slug), limit: openSlots });
    if (candidates.length === 0) {
      return jsonOk({ added: [], candidates: [], keyword, reason: 'no_results' });
    }

    const inserted: Array<{ id: string; slug: string }> = [];
    for (const c of candidates) {
      const [row] = await db().insert(linkedinCompanies)
        .values({
          userId: user.id, slug: c.slug, url: c.url,
          name: c.name, industry: c.industry, followers: c.followers,
          notes: `auto-discovered · "${keyword}"`,
        })
        .onConflictDoNothing()
        .returning({ id: linkedinCompanies.id, slug: linkedinCompanies.slug });
      if (row) inserted.push(row);
    }

    // scrape the freshly added companies now (cost guard skips any done today)
    const scraped = inserted.length
      ? await refreshLinkedIn(user.id)
      : { scraped: 0, failed: [] as string[], source: 'apify' as const, error: undefined as string | undefined };

    // drop any just-added company that produced no metrics row (scrape failed /
    // unresolvable / quota) so discovery never leaves dead 0-follower cards
    const survivors: string[] = [];
    if (inserted.length) {
      const withData = await db()
        .select({ companyId: linkedinMetrics.companyId })
        .from(linkedinMetrics)
        .where(inArray(linkedinMetrics.companyId, inserted.map((i) => i.id)));
      const haveData = new Set(withData.map((w) => w.companyId));
      const dead = inserted.filter((i) => !haveData.has(i.id));
      if (dead.length) {
        await db().delete(linkedinCompanies).where(inArray(linkedinCompanies.id, dead.map((d) => d.id)));
      }
      for (const i of inserted) if (haveData.has(i.id)) survivors.push(i.slug);
    }

    if (survivors.length) {
      await db().insert(activityLog).values({
        userId: user.id, kind: 'linkedin_added',
        title: `Auto-discovered ${survivors.length} LinkedIn competitor${survivors.length === 1 ? '' : 's'}`,
      });
      await recordUsage(user.id, 'analysis', 1, { feature: 'linkedin_discover' });
    }

    return jsonOk({
      added: survivors, candidates, keyword,
      error: scraped.error,
      reason: !survivors.length && scraped.error ? 'apify_error' : undefined,
    });
  }, req);
}
