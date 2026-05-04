import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { drafts, type Platform, PLATFORMS } from '../../../../lib/db/schema';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const [row] = await db()
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
      .limit(1);
    if (!row) return jsonError('not_found', 404);
    return row;
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const body = await req.json().catch(() => ({}));
    const patch: Partial<typeof drafts.$inferInsert> = {};
    if ('title' in body) patch.title = body.title ?? null;
    if ('prompt' in body) patch.prompt = body.prompt ?? null;
    if ('body' in body) patch.body = body.body ?? '';
    if ('variants' in body) patch.variants = body.variants ?? [];
    if ('selectedVariantLabel' in body) patch.selectedVariantLabel = body.selectedVariantLabel ?? null;
    if ('media' in body) patch.media = body.media ?? [];
    if ('targetPlatforms' in body) {
      patch.targetPlatforms = (body.targetPlatforms as string[]).filter(
        (p): p is Platform => (PLATFORMS as readonly string[]).includes(p),
      );
    }
    if ('perPlatformText' in body) patch.perPlatformText = body.perPlatformText ?? {};
    if ('preset' in body) patch.preset = body.preset ?? null;
    if ('status' in body) patch.status = body.status;
    patch.updatedAt = new Date();

    const [row] = await db()
      .update(drafts)
      .set(patch)
      .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
      .returning();
    if (!row) return jsonError('not_found', 404);
    return row;
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const [row] = await db()
      .delete(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
      .returning();
    if (!row) return jsonError('not_found', 404);
    return { ok: true };
  });
}
