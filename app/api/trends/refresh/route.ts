import { eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings, trends, type Niche } from '../../../../lib/db/schema';
import { fetchTrendsForNiches } from '../../../../lib/trends/sources';

// POST /api/trends/refresh
// Pulls new trends for the current user based on their selected niches.
// Used by the "Refresh trends" button in the UI.
export async function POST() {
  return withUser(async (user) => {
    const [settings] = await db().select().from(agentSettings).where(eq(agentSettings.userId, user.id)).limit(1);
    const niches = ((settings?.niches ?? []) as string[]).filter((n) => n.length > 0) as Niche[];
    if (niches.length === 0) {
      return { inserted: 0, reason: 'no_niches' };
    }
    const candidates = await fetchTrendsForNiches(niches);
    let inserted = 0;
    for (const c of candidates) {
      await db().insert(trends).values({
        userId: user.id,
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
    return { inserted };
  });
}
