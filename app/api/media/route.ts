import { NextRequest } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { mediaAssets } from '../../../lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET /api/media — list the current user's media assets, newest first.
 *
 * Used by the compose page to restore the image/video grid after navigation.
 * Before this endpoint existed, generated images and videos vanished from
 * the UI the moment the user moved to another tab and came back — the rows
 * were in R2 + Postgres, just never re-fetched.
 *
 * Returns at most `limit` rows (default 40, max 100). Clients filter by
 * mimeType prefix locally — there's no need for type-specific endpoints.
 */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get('limit') ?? '40');
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 40, 1), 100);
    const rows = await db()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.userId, user.id))
      .orderBy(desc(mediaAssets.createdAt))
      .limit(limit);
    return { items: rows };
  }, req);
}
