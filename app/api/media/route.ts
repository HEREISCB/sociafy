import { NextRequest } from 'next/server';
import { and, desc, eq, lt } from 'drizzle-orm';
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
 *
 * `?before=<ISO timestamp>` pages backwards through history: pass the
 * `createdAt` of the oldest row you already have and you get the next page.
 * Without it "history" meant "the last 40 things" with nothing older
 * reachable at all.
 *
 * ponytail: a plain `createdAt <` cursor, so rows sharing an exact timestamp
 * on a page boundary can be skipped. The client de-dupes by id; upgrade to a
 * (createdAt, id) composite cursor only if that ever bites.
 */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get('limit') ?? '40');
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 40, 1), 100);
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw ? new Date(beforeRaw) : null;
    const scope = eq(mediaAssets.userId, user.id);
    const rows = await db()
      .select()
      .from(mediaAssets)
      .where(before && !Number.isNaN(before.getTime()) ? and(scope, lt(mediaAssets.createdAt, before)) : scope)
      .orderBy(desc(mediaAssets.createdAt))
      .limit(limit);
    return { items: rows };
  }, req);
}
