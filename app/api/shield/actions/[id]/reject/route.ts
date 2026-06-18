import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../../../../lib/db';
import { shieldActions, activityLog } from '../../../../../../lib/db/schema';
import { authedUser } from '../../../../../../lib/api';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const [action] = await db()
    .select()
    .from(shieldActions)
    .where(and(eq(shieldActions.id, id), eq(shieldActions.userId, user.id)))
    .limit(1);

  if (!action) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await db()
    .update(shieldActions)
    .set({ status: 'rejected', approvedBy: user.id, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(shieldActions.id, id));

  await db().insert(activityLog).values({
    userId: user.id,
    kind: 'shield_response_rejected',
    title: 'Shield response dismissed',
    meta: { shieldActionId: id },
  });

  return NextResponse.json({ ok: true });
}
