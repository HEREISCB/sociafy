import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { voices } from '../../../../lib/db/schema';
import { deleteObject } from '../../../../lib/storage/r2';
import { parseBody, voiceRenameSchema } from '../../../../lib/validation';

export const runtime = 'nodejs';

/** PATCH /api/voices/[id] { name } — rename a Voice Twin. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const parsed = parseBody(voiceRenameSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const [row] = await db()
      .update(voices)
      .set({ name: parsed.data.name })
      .where(and(eq(voices.id, id), eq(voices.userId, user.id)))
      .returning({ id: voices.id, name: voices.name });
    if (!row) return jsonError('voice_not_found', 404);
    return { voice: row };
  }, req);
}

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
