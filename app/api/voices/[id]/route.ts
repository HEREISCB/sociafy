import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { voices } from '../../../../lib/db/schema';
import { deleteObject } from '../../../../lib/storage/r2';

export const runtime = 'nodejs';

/** DELETE /api/voices/[id] — remove a Voice Twin (and best-effort its R2 clip). */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const [row] = await db()
      .select()
      .from(voices)
      .where(and(eq(voices.id, id), eq(voices.userId, user.id)))
      .limit(1);
    if (!row) return jsonError('voice_not_found', 404);

    await db().delete(voices).where(and(eq(voices.id, id), eq(voices.userId, user.id)));
    // Best-effort cleanup of the reference clip; never block deletion on it.
    if (row.refStorageKey && row.refStorageKey !== 'stub') {
      try {
        await deleteObject(row.refStorageKey);
      } catch {
        /* ignore — the row is already gone */
      }
    }
    return { ok: true };
  }, req);
}
