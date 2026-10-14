import { NextRequest } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { connectedAccounts, scheduledPosts, type ScheduledStatus } from '../../../../lib/db/schema';
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
      // The cron only claims status='pending', so a failed or canceled row
      // given a new time used to show the new time and never publish. Requeue it.
      // Only a row the user canceled may come back: one superseded by Post now
      // (or canceled by an account disconnect) would publish a second time.
      if (existing.status === 'canceled' && existing.error !== USER_CANCELED) {
        return jsonError('not_restorable', 409);
      }
      if (existing.status === 'failed' || existing.status === 'canceled') {
        patch.status = 'pending';
        patch.attempts = 0;
        patch.error = null;
        // Disconnecting an account nulls account_id on its rows; requeued
        // as-is the cron would fail it straight away with no_account.
        if (!existing.accountId) {
          const [acct] = await db()
            .select({ id: connectedAccounts.id })
            .from(connectedAccounts)
            .where(and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.platform, existing.platform)))
            .limit(1);
          if (!acct) return jsonError('account_disconnected', 409);
          patch.accountId = acct.id;
        }
      }
    }
    if (body.text !== undefined) patch.text = body.text;
    if (body.status === 'canceled') {
      if (!CANCELABLE.includes(existing.status)) return jsonError('not_cancelable', 409);
      patch.status = 'canceled';
      patch.error = USER_CANCELED;
    }
    // Conditional on the status we validated against: the cron may have
    // claimed the row since we read it, and a write landing on a
    // 'publishing' row would cancel (or requeue) a post that is going live.
    const [row] = await db()
      .update(scheduledPosts)
      .set(patch)
      .where(and(
        eq(scheduledPosts.id, id),
        eq(scheduledPosts.userId, user.id),
        eq(scheduledPosts.status, existing.status),
      ))
      .returning();
    if (!row) return jsonError('conflict', 409);
    return row;
  }, req);
}

// What cancel (DELETE, or PATCH status:'canceled') may touch. A 'publishing'
// row is in flight and a 'published' one is history.
const CANCELABLE: ScheduledStatus[] = ['pending', 'failed'];
// Marks a cancel the user made — the only kind of canceled row PATCH may requeue.
const USER_CANCELED = 'user_canceled';

// Soft cancel: the row stays as 'canceled' so the calendar can Restore it
// (a PATCH with a new scheduledAt requeues it as 'pending').
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const [existing] = await db()
      .select({ status: scheduledPosts.status })
      .from(scheduledPosts)
      .where(and(eq(scheduledPosts.id, id), eq(scheduledPosts.userId, user.id)))
      .limit(1);
    if (!existing) return jsonError('not_found', 404);
    if (!CANCELABLE.includes(existing.status)) return jsonError('not_cancelable', 409);
    // Conditional on a cancelable status: the cron may claim the row between
    // the read and this write.
    const [row] = await db()
      .update(scheduledPosts)
      .set({ status: 'canceled', error: USER_CANCELED, updatedAt: new Date() })
      .where(and(
        eq(scheduledPosts.id, id),
        eq(scheduledPosts.userId, user.id),
        inArray(scheduledPosts.status, CANCELABLE),
      ))
      .returning();
    if (!row) return jsonError('not_cancelable', 409);
    return row;
  }, req);
}
