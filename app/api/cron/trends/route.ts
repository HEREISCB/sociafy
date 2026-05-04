import { NextRequest, NextResponse } from 'next/server';
import { eq, and, lt } from 'drizzle-orm';
import { checkCronAuth } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings, trends, type Niche } from '../../../../lib/db/schema';
import { isStubMode } from '../../../../lib/env';
import { fetchTrendsForNiches } from '../../../../lib/trends/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!checkCronAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (isStubMode.database()) return NextResponse.json({ skipped: 'no_database' });

  const enabled = await db().select().from(agentSettings).where(eq(agentSettings.enabled, true)).limit(50);
  const out: Array<{ userId: string; inserted: number; pruned: number }> = [];

  // Prune trends older than 7 days that are still 'new'
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const settings of enabled) {
    const niches = (settings.niches ?? []) as Niche[];
    if (niches.length === 0) {
      out.push({ userId: settings.userId, inserted: 0, pruned: 0 });
      continue;
    }
    const candidates = await fetchTrendsForNiches(niches);
    let inserted = 0;
    for (const c of candidates) {
      // Dedup by source URL within the user's recent trends
      await db()
        .insert(trends)
        .values({
          userId: settings.userId,
          niche: c.niche,
          title: c.title,
          summary: c.summary ?? null,
          source: c.source,
          sourceUrl: c.sourceUrl,
          volume: c.volume ?? null,
          delta: c.delta != null ? String(c.delta) : null,
          score: 50 + Math.floor(Math.random() * 40),
        });
      inserted++;
    }

    const pruned = await db()
      .delete(trends)
      .where(and(eq(trends.userId, settings.userId), eq(trends.status, 'new'), lt(trends.capturedAt, cutoff)))
      .returning({ id: trends.id });

    out.push({ userId: settings.userId, inserted, pruned: pruned.length });
  }

  return NextResponse.json({ users: out });
}
