import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { scheduledPosts } from '../../../../lib/db/schema';
import { scheduleUpdateSchema, parseBody } from '../../../../lib/validation';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(scheduleUpdateSchema, raw);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const [existing] = await db()
      .select()
      .from(scheduledPosts)
      .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.userId, user.id)))
      .limit(1);
    if (!existing) return jsonError('not_found', 404);

    const patch: Partial<typeof scheduledPosts.$inferInsert> = { updatedAt: new Date() };
    if (body.scheduledAt) {
      const d = new Date(body.scheduledAt);
      if (d.getTime() < Date.now() - 60_000) return jsonError('scheduledAt_in_past');
      // A live or in-flight post can't be moved — and flipping it back to
      // 'pending' would hand it to the next cron tick for a second publish.
      if (existing.status === 'published' || existing.status === 'publishing') {
        return jsonError('already_published');
      }
      patch.scheduledAt = d;
      // The cron only claims status='pending', so a failed row given a new
      // time used to show the new time and never publish. Requeue it.
      if (existing.status === 'failed') {
        patch.status = 'pending';
        patch.attempts = 0;
        patch.error = null;
      }
    }
    if (body.text !== undefined) patch.text = body.text;
    if (body.status === 'canceled') patch.status = 'canceled';
    const [row] = await db()
      .update(scheduledPosts)
      .set(patch)
      .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.userId, user.id)))
      .returning();
    if (!row) return jsonError('not_found', 404);
    return row;
  }, req);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const [row] = await db()
      .delete(scheduledPosts)
      .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.userId, user.id)))
      .returning();
    if (!row) return jsonError('not_found', 404);
    return { ok: true };
  }, req);
}
