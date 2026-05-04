import { NextRequest } from 'next/server';
import { eq, desc, and } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { drafts, activityLog, type DraftVariant, type DraftMedia } from '../../../lib/db/schema';
import { type Platform, PLATFORMS } from '../../../lib/db/schema';

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
    const body = await req.json().catch(() => ({}));
    const platforms = (Array.isArray(body?.targetPlatforms) ? body.targetPlatforms : [])
      .filter((p: string): p is Platform => (PLATFORMS as readonly string[]).includes(p));
    const [row] = await db()
      .insert(drafts)
      .values({
        userId: user.id,
        title: body?.title ?? null,
        prompt: body?.prompt ?? null,
        body: body?.body ?? '',
        variants: (body?.variants as DraftVariant[]) ?? [],
        selectedVariantLabel: body?.selectedVariantLabel ?? null,
        media: (body?.media as DraftMedia[]) ?? [],
        targetPlatforms: platforms,
        perPlatformText: body?.perPlatformText ?? {},
        preset: body?.preset ?? null,
        source: body?.source === 'agent' ? 'agent' : 'user',
      })
      .returning();
    await db().insert(activityLog).values({
      userId: user.id,
      kind: 'draft_created',
      title: `Draft created${row.title ? `: ${row.title}` : ''}`,
      meta: { draftId: row.id, source: row.source },
    });
    return row;
  });
}
