import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { mediaPosters } from '../db/schema';
import { publicUrlFor } from '../storage/r2';

/**
 * Video posters (media_posters, 0022): the still a thumbnail shows instead of
 * mounting the video. Best-effort both ways — before the migration runs, or on
 * any error, reads return nothing and the UI seeks the video as before.
 */

/** Record an asset's poster. Only a key inside the owner's prefix; idempotent. */
export async function savePoster(userId: string, assetId: string, posterKey: string | null | undefined): Promise<string | null> {
  if (!posterKey?.startsWith(`users/${userId}/`)) return null;
  try {
    await db().insert(mediaPosters).values({ assetId, posterKey })
      .onConflictDoUpdate({ target: mediaPosters.assetId, set: { posterKey } });
    return publicUrlFor(posterKey);
  } catch (e) {
    console.warn('[posters] save failed:', e instanceof Error ? e.message.slice(0, 200) : e);
    return null;
  }
}

/** asset id → poster URL, for this user's assets only (a key outside their prefix is ignored). */
export async function posterUrls(userId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))];
  if (!uniq.length) return new Map();
  try {
    const rows = await db().select().from(mediaPosters).where(inArray(mediaPosters.assetId, uniq));
    return new Map(rows.filter((r) => r.posterKey.startsWith(`users/${userId}/`)).map((r) => [r.assetId, publicUrlFor(r.posterKey)]));
  } catch {
    return new Map();
  }
}

/** Add posterUrl to every media item (drafts/posts `media` jsonb) that has one. */
export async function withPosters<T extends { media?: { id: string }[] | null }>(userId: string, rows: T[]): Promise<T[]> {
  const map = await posterUrls(userId, rows.flatMap((r) => (r.media ?? []).map((m) => m.id)));
  if (!map.size) return rows;
  return rows.map((r) => (r.media?.some((m) => map.has(m.id))
    ? { ...r, media: r.media.map((m) => (map.has(m.id) ? { ...m, posterUrl: map.get(m.id) } : m)) }
    : r));
}
