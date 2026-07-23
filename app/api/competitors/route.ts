import { NextRequest } from 'next/server';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { withUser, jsonOk, jsonError } from '../../../lib/api';
import { isStubMode } from '../../../lib/env';
import { db } from '../../../lib/db';
import { competitors, competitorMetrics, activityLog } from '../../../lib/db/schema';

const MAX_ACTIVE = 10;

export async function GET() {
  return withUser(async (user) => {
    if (isStubMode.database()) return [];
    const rows = await db()
      .select()
      .from(competitors)
      .where(eq(competitors.userId, user.id))
      .orderBy(desc(competitors.createdAt));
    if (rows.length === 0) return [];

    const metrics = await db()
      .select()
      .from(competitorMetrics)
      .where(inArray(competitorMetrics.competitorId, rows.map((r) => r.id)))
      .orderBy(asc(competitorMetrics.date));

    const byCompetitor = new Map<string, typeof metrics>();
    for (const m of metrics) {
      if (!byCompetitor.has(m.competitorId)) byCompetitor.set(m.competitorId, []);
      byCompetitor.get(m.competitorId)!.push(m);
    }

    return rows.map((r) => {
      const series = byCompetitor.get(r.id) ?? [];
      const latest = series[series.length - 1];
      return {
        ...r,
        latestFollowers: latest?.followers ?? r.followers,
        latestEngagementRate: latest?.avgEngagementRate ?? 0,
        metrics: series.map((m) => ({ date: m.date, followers: m.followers, avgEngagementRate: m.avgEngagementRate })),
      };
    });
  });
}

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const body = await req.json().catch(() => ({}));
    const handle = typeof body.handle === 'string' ? body.handle.trim().replace(/^@/, '') : '';
    if (!handle) return jsonError('handle required');
    const platform = typeof body.platform === 'string' && body.platform ? body.platform : 'instagram';
    const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 120) : null;
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 500) : null;

    const active = await db()
      .select({ id: competitors.id })
      .from(competitors)
      .where(and(eq(competitors.userId, user.id), eq(competitors.isActive, true)));
    if (active.length >= MAX_ACTIVE) {
      return jsonError('max_active_competitors', 400, { limit: MAX_ACTIVE });
    }

    const [row] = await db().insert(competitors)
      .values({ userId: user.id, platform, handle, displayName, notes })
      .onConflictDoNothing()
      .returning();
    if (!row) return jsonError('competitor_exists', 409);

    await db().insert(activityLog).values({
      userId: user.id, kind: 'competitor_added',
      title: `Tracking competitor @${handle}`,
    });

    return jsonOk(row, { status: 201 });
  }, req);
}
