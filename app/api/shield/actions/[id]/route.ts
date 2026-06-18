import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../../../lib/db';
import { shieldActions } from '../../../../../lib/db/schema';
import { authedUser } from '../../../../../lib/api';

export const runtime = 'nodejs';

// PATCH /api/shield/actions/[id] — update the draft script before approving
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({})) as { script?: string; targetPlatform?: string };

  const [action] = await db()
    .select()
    .from(shieldActions)
    .where(and(eq(shieldActions.id, id), eq(shieldActions.userId, user.id)))
    .limit(1);

  if (!action) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await db()
    .update(shieldActions)
    .set({
      ...(body.script !== undefined ? { script: body.script } : {}),
      ...(body.targetPlatform !== undefined ? { targetPlatform: body.targetPlatform } : {}),
      updatedAt: new Date(),
    })
    .where(eq(shieldActions.id, id));

  return NextResponse.json({ ok: true });
}
