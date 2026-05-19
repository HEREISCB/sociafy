import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { drafts } from '../../../../lib/db/schema';
import { draftUpdateSchema, parseBody } from '../../../../lib/validation';

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
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(draftUpdateSchema, raw);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const patch: Partial<typeof drafts.$inferInsert> = {};
    if (body.title !== undefined) patch.title = body.title ?? null;
    if (body.prompt !== undefined) patch.prompt = body.prompt ?? null;
    if (body.body !== undefined) patch.body = body.body;
    if (body.variants !== undefined) patch.variants = body.variants;
    if (body.selectedVariantLabel !== undefined) patch.selectedVariantLabel = body.selectedVariantLabel ?? null;
    if (body.media !== undefined) patch.media = body.media;
    if (body.targetPlatforms !== undefined) patch.targetPlatforms = body.targetPlatforms;
    if (body.perPlatformText !== undefined) patch.perPlatformText = body.perPlatformText;
    if (body.preset !== undefined) patch.preset = body.preset ?? null;
    if (body.status !== undefined) patch.status = body.status;
    patch.updatedAt = new Date();

    const [row] = await db()
      .update(drafts)
      .set(patch)
      .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
      .returning();
    if (!row) return jsonError('not_found', 404);
    return row;
  }, req);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withUser(async (user) => {
    const [row] = await db()
      .delete(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
      .returning();
    if (!row) return jsonError('not_found', 404);
    return { ok: true };
  }, req);
}
