import { desc, eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { db } from '../../../../lib/db';
import { trendSnapshots } from '../../../../lib/db/schema';

export async function GET() {
  return withUser(async (user) => {
    if (isStubMode.database()) return [];
    const snaps = await db()
      .select()
      .from(trendSnapshots)
      .where(eq(trendSnapshots.userId, user.id))
      .orderBy(desc(trendSnapshots.fetchedAt))
      .limit(50);
    return snaps.map((s) => ({ id: s.id, name: s.label ?? s.id, rows: s.postCount, source: s.source, fetchedAt: s.fetchedAt }));
  });
}
