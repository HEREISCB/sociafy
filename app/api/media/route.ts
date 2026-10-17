import { NextRequest } from 'next/server';
import { and, desc, eq, inArray, lt, notInArray } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { mediaAssets, videoJobs } from '../../../lib/db/schema';
import { MOTION_AI } from '../../../lib/ai/models';
import { BRAND_ONLY_MIMES } from '../../../lib/brand/assets';

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
    // Brand-kit-only files (SVG, fonts, PDF) can't be posted; keep them out of the library.
    const scope = and(eq(mediaAssets.userId, user.id), notInArray(mediaAssets.mimeType, BRAND_ONLY_MIMES));
    const rows = await db()
      .select()
      .from(mediaAssets)
      .where(before && !Number.isNaN(before.getTime()) ? and(scope, lt(mediaAssets.createdAt, before)) : scope)
      .orderBy(desc(mediaAssets.createdAt))
      .limit(limit);
    // Flag AI-designed motion graphics so the composer can offer Edit on them.
    const videoIds = rows.filter((r) => r.mimeType.startsWith('video/')).map((r) => r.id);
    const editable = new Set(videoIds.length
      ? (await db().select({ id: videoJobs.mediaAssetId }).from(videoJobs)
          .where(and(eq(videoJobs.userId, user.id), eq(videoJobs.provider, MOTION_AI.backend), inArray(videoJobs.mediaAssetId, videoIds)))).map((r) => r.id)
      : []);
    return { items: rows.map((r) => (editable.has(r.id) ? { ...r, motionAi: true } : r)) };
  }, req);
}
