import { NextRequest } from 'next/server';
import { eq, desc, and } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { drafts, activityLog } from '../../../lib/db/schema';
import { draftCreateSchema, parseBody } from '../../../lib/validation';

export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const status = req.nextUrl.searchParams.get('status');
    const where = status
      ? and(eq(drafts.userId, user.id), eq(drafts.status, status as 'draft' | 'scheduled' | 'published' | 'archived'))
      : eq(drafts.userId, user.id);
    const rows = await db()
      .select()
      .from(drafts)
      .where(where)
      .orderBy(desc(drafts.updatedAt))
      .limit(200);
    return rows;
  });
}

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(draftCreateSchema, raw);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const [row] = await db()
      .insert(drafts)
      .values({
        userId: user.id,
        title: body.title ?? null,
        prompt: body.prompt ?? null,
        body: body.body ?? '',
        variants: body.variants ?? [],
        selectedVariantLabel: body.selectedVariantLabel ?? null,
        media: body.media ?? [],
        targetPlatforms: body.targetPlatforms ?? [],
        perPlatformText: body.perPlatformText ?? {},
        preset: body.preset ?? null,
        source: (raw as { source?: string })?.source === 'agent' ? 'agent' : 'user',
      })
      .returning();
    await db().insert(activityLog).values({
      userId: user.id,
      kind: 'draft_created',
      title: `Draft created${row.title ? `: ${row.title}` : ''}`,
      meta: { draftId: row.id, source: row.source },
    });
    return row;
  }, req);
}
