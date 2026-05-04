import { NextRequest } from 'next/server';
import { and, eq, desc } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { trends } from '../../../lib/db/schema';

export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const status = req.nextUrl.searchParams.get('status') || 'new';
    const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '20', 10), 100);
    const rows = await db()
      .select()
      .from(trends)
      .where(and(eq(trends.userId, user.id), eq(trends.status, status as 'new' | 'used' | 'dismissed')))
      .orderBy(desc(trends.score), desc(trends.capturedAt))
      .limit(limit);
    return rows;
  });
}
