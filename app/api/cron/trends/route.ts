import { NextRequest, NextResponse } from 'next/server';
import { eq, and, lt, inArray } from 'drizzle-orm';
import { checkCronAuth } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings, trends } from '../../../../lib/db/schema';
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
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const settings of enabled) {
    const niches = ((settings.niches ?? []) as string[]).filter((n) => n.length > 0);
    if (niches.length === 0) {
      out.push({ userId: settings.userId, inserted: 0, pruned: 0 });
      continue;
    }
    const candidates = await fetchTrendsForNiches(niches);
    const incomingUrls = candidates.map((c) => c.sourceUrl);
    const existing = await db()
      .select({ url: trends.sourceUrl })
      .from(trends)
      .where(and(eq(trends.userId, settings.userId), inArray(trends.sourceUrl, incomingUrls)));
    const have = new Set(existing.map((e) => e.url));

    let inserted = 0;
    for (const c of candidates) {
      if (have.has(c.sourceUrl)) continue;
      const score = scoreFromVolume(c.source, c.volume, c.delta);
      // niche is text in DB; the TS enum cast keeps Drizzle happy for predefined + custom values alike
      await db().insert(trends).values({
        userId: settings.userId,
        niche: c.niche as 'saas' | 'creator-economy' | 'marketing' | 'ai' | 'design' | 'devtools' | 'fintech' | 'media' | 'community',
        title: c.title,
        summary: c.summary ?? null,
        source: c.source,
        sourceUrl: c.sourceUrl,
        volume: c.volume ?? null,
        delta: c.delta != null ? String(c.delta) : null,
        score,
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

function scoreFromVolume(source: string, volume?: number | null, delta?: number | null): number {
  if (volume == null && delta == null) return 60;
  if (source === 'Hacker News') {
    const points = volume ?? 0;
    return Math.max(40, Math.min(100, 40 + Math.round(Math.log10(points + 1) * 18)));
  }
  if (source.startsWith('Reddit')) {
    const upvotes = volume ?? 0;
    return Math.max(40, Math.min(100, 35 + Math.round(Math.log10(upvotes + 1) * 14)));
  }
  if (source === 'dev.to') {
    const reactions = volume ?? 0;
    return Math.max(40, Math.min(100, 40 + Math.round(Math.log10(reactions + 1) * 16)));
  }
  return 60;
}
