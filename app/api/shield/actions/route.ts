import { NextRequest, NextResponse } from 'next/server';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { shieldActions, mentions } from '../../../../lib/db/schema';
import { authedUser } from '../../../../lib/api';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const status = searchParams.get('status');
  const limit = Math.min(100, Number(searchParams.get('limit') || '50'));

  const validStatuses = ['pending', 'approved', 'rejected', 'published', 'failed'] as const;

  const rows = await db()
    .select({
      action: shieldActions,
      mention: mentions,
    })
    .from(shieldActions)
    .innerJoin(mentions, eq(shieldActions.mentionId, mentions.id))
    .where(
      and(
        eq(shieldActions.userId, user.id),
        status && validStatuses.includes(status as typeof validStatuses[number])
          ? eq(shieldActions.status, status as typeof validStatuses[number])
          : undefined,
      ),
    )
    .orderBy(desc(shieldActions.createdAt))
    .limit(limit);

  return NextResponse.json({
    actions: rows.map(r => ({
      ...r.action,
      mention: r.mention,
    })),
  });
}
