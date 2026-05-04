import { NextRequest } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { activityLog } from '../../../lib/db/schema';

export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50', 10), 200);
    const rows = await db()
      .select()
      .from(activityLog)
      .where(eq(activityLog.userId, user.id))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);
    return rows;
  });
}
