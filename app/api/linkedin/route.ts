import { NextRequest } from 'next/server';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { withUser, jsonOk, jsonError } from '../../../lib/api';
import { isStubMode } from '../../../lib/env';
import { db } from '../../../lib/db';
import { linkedinCompanies, linkedinMetrics, activityLog } from '../../../lib/db/schema';
import { linkedinLandscape, type LiCompany } from '../../../lib/intel/linkedin-intel';
import { linkedinSlug, companyUrl } from '../../../lib/scrapers/linkedin';

const MAX_ACTIVE = 10;

export async function GET() {
  return withUser(async (user) => {
    if (isStubMode.database()) return { companies: [], landscape: null };
    const rows = await db()
      .select()
      .from(linkedinCompanies)
      .where(eq(linkedinCompanies.userId, user.id))
      .orderBy(desc(linkedinCompanies.createdAt));
    if (rows.length === 0) return { companies: [], landscape: null };

    const metrics = await db()
      .select()
      .from(linkedinMetrics)
      .where(inArray(linkedinMetrics.companyId, rows.map((r) => r.id)))
      .orderBy(asc(linkedinMetrics.date));
    const byCompany = new Map<string, typeof metrics>();
    for (const m of metrics) {
      if (!byCompany.has(m.companyId)) byCompany.set(m.companyId, []);
      byCompany.get(m.companyId)!.push(m);
    }

    const companies: LiCompany[] = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      industry: r.industry,
      website: r.website,
      headquarters: r.headquarters,
      foundedYear: r.foundedYear,
      specialities: r.specialities ?? [],
      logoUrl: r.logoUrl,
      followers: r.followers ?? 0,
      employees: r.employees ?? 0,
      metrics: (byCompany.get(r.id) ?? []).map((m) => ({ date: m.date, followers: m.followers, employees: m.employees })),
    }));

    return { companies, landscape: linkedinLandscape(companies) };
  });
}

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const body = await req.json().catch(() => ({}));
    const input = typeof body.url === 'string' ? body.url.trim() : '';
    if (!input) return jsonError('company url or handle required');
    const slug = linkedinSlug(input);
    if (!slug) return jsonError('could not parse a LinkedIn company from that input');

    const active = await db()
      .select({ id: linkedinCompanies.id })
      .from(linkedinCompanies)
      .where(and(eq(linkedinCompanies.userId, user.id), eq(linkedinCompanies.isActive, true)));
    if (active.length >= MAX_ACTIVE) {
      return jsonError('max_active_companies', 400, { limit: MAX_ACTIVE });
    }

    const [row] = await db().insert(linkedinCompanies)
      .values({
        userId: user.id, slug, url: companyUrl(input),
        name: typeof body.name === 'string' ? body.name.slice(0, 120) : null,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return jsonError('company_exists', 409);

    await db().insert(activityLog).values({
      userId: user.id, kind: 'linkedin_added',
      title: `Tracking LinkedIn company ${slug}`,
    });

    return jsonOk(row, { status: 201 });
  }, req);
}
