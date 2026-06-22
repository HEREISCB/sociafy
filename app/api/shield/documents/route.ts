import { NextRequest, NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { shieldDocuments } from '../../../../lib/db/schema';
import { authedUser } from '../../../../lib/api';

export const runtime = 'nodejs';

const MAX_TITLE = 200;
const MAX_CONTENT = 50_000; // ~50k chars per doc; whole KB is budgeted at inject time
const MAX_DOCS = 50;

// GET — list the current user's brand-knowledge documents (full content so the
// UI can edit them inline).
export async function GET() {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = await db()
    .select()
    .from(shieldDocuments)
    .where(eq(shieldDocuments.userId, user.id))
    .orderBy(desc(shieldDocuments.updatedAt));

  return NextResponse.json({ documents: rows });
}

// POST — create a new document. Body: { title?, content }.
export async function POST(req: NextRequest) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { title?: string; content?: string };
  const content = (body.content ?? '').trim();
  if (!content) return NextResponse.json({ error: 'empty_content' }, { status: 400 });

  const existing = await db()
    .select({ id: shieldDocuments.id })
    .from(shieldDocuments)
    .where(eq(shieldDocuments.userId, user.id));
  if (existing.length >= MAX_DOCS) {
    return NextResponse.json({ error: 'too_many_documents', max: MAX_DOCS }, { status: 422 });
  }

  const title = (body.title ?? '').trim().slice(0, MAX_TITLE) || 'Untitled';

  const [row] = await db()
    .insert(shieldDocuments)
    .values({ userId: user.id, title, content: content.slice(0, MAX_CONTENT) })
    .returning();

  return NextResponse.json({ document: row }, { status: 201 });
}
