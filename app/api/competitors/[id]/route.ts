import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonOk, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { competitors } from '../../../../lib/db/schema';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const patch: Partial<{ displayName: string; notes: string; isActive: boolean; updatedAt: Date }> = { updatedAt: new Date() };
    if (typeof body.displayName === 'string') patch.displayName = body.displayName.slice(0, 120);
    if (typeof body.notes === 'string') patch.notes = body.notes.slice(0, 500);
    if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;

    const [updated] = await db()
      .update(competitors)
      .set(patch)
      .where(and(eq(competitors.id, id), eq(competitors.userId, user.id)))
      .returning();
    if (!updated) return jsonError('not found', 404);
    return jsonOk(updated);
  }, req);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await params;
    const removed = await db()
      .delete(competitors)
      .where(and(eq(competitors.id, id), eq(competitors.userId, user.id)))
      .returning({ id: competitors.id });
    if (removed.length === 0) return jsonError('not found', 404);
    return jsonOk({ removed: id });
  }, req);
}
