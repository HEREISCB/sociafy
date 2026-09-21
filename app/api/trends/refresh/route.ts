import { eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings } from '../../../../lib/db/schema';
import { refreshTrendsForUser } from '../../../../lib/cron/trends';

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
    return { inserted: await refreshTrendsForUser(user.id, niches) };
  });
}
