import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../../../lib/db';
import { shieldDocuments } from '../../../../../lib/db/schema';
import { authedUser } from '../../../../../lib/api';

export const runtime = 'nodejs';

const MAX_TITLE = 200;
const MAX_CONTENT = 50_000;

// PATCH — update a document's title and/or content.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { title?: string; content?: string };

  const updates: { title?: string; content?: string; updatedAt: Date } = { updatedAt: new Date() };
  if (typeof body.title === 'string') updates.title = body.title.trim().slice(0, MAX_TITLE) || 'Untitled';
  if (typeof body.content === 'string') updates.content = body.content.slice(0, MAX_CONTENT);

  const [row] = await db()
    .update(shieldDocuments)
    .set(updates)
    .where(and(eq(shieldDocuments.id, id), eq(shieldDocuments.userId, user.id)))
    .returning();

  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ document: row });
}

// DELETE — remove a document.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const [row] = await db()
    .delete(shieldDocuments)
    .where(and(eq(shieldDocuments.id, id), eq(shieldDocuments.userId, user.id)))
    .returning({ id: shieldDocuments.id });

  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
