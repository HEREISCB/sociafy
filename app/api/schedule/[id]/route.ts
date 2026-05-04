import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { scheduledPosts } from '../../../../lib/db/schema';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const body = await req.json().catch(() => ({}));
    const patch: Partial<typeof scheduledPosts.$inferInsert> = { updatedAt: new Date() };
    if (body?.scheduledAt) {
      const d = new Date(body.scheduledAt);
      if (Number.isNaN(d.getTime())) return jsonError('scheduledAt_invalid');
      patch.scheduledAt = d;
    }
    if (body?.text !== undefined) patch.text = body.text;
    if (body?.status === 'canceled') patch.status = 'canceled';
    const [row] = await db()
      .update(scheduledPosts)
      .set(patch)
      .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.userId, user.id)))
      .returning();
    if (!row) return jsonError('not_found', 404);
    return row;
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const [row] = await db()
      .delete(scheduledPosts)
      .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.userId, user.id)))
      .returning();
    if (!row) return jsonError('not_found', 404);
    return { ok: true };
  });
}
