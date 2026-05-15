import { and, eq, inArray } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings, trends } from '../../../../lib/db/schema';
import { fetchTrendsForNiches } from '../../../../lib/trends/sources';

// POST /api/trends/refresh
// Pulls new trends for the current user based on their selected niches.
// Used by the "Refresh trends" button in the UI.
export async function POST() {
  return withUser(async (user) => {
    const [settings] = await db().select().from(agentSettings).where(eq(agentSettings.userId, user.id)).limit(1);
    const niches = ((settings?.niches ?? []) as string[]).filter((n) => n.length > 0);
    if (niches.length === 0) {
      return { inserted: 0, reason: 'no_niches' };
    }
    const candidates = await fetchTrendsForNiches(niches);
    if (candidates.length === 0) return { inserted: 0 };

    // Dedup vs existing rows (same source URL)
    const incomingUrls = candidates.map((c) => c.sourceUrl);
    const existing = await db()
      .select({ url: trends.sourceUrl })
      .from(trends)
      .where(and(eq(trends.userId, user.id), inArray(trends.sourceUrl, incomingUrls)));
    const have = new Set(existing.map((e) => e.url));

    let inserted = 0;
    for (const c of candidates) {
      if (have.has(c.sourceUrl)) continue;
      const score = scoreFromVolume(c.source, c.volume, c.delta);
      await db().insert(trends).values({
        userId: user.id,
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
    return { inserted };
  });
}

// Map engagement metrics to a 0-100 score, normalised per source.
function scoreFromVolume(source: string, volume?: number, delta?: number): number {
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
