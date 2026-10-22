import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { mediaAssets } from '../db/schema';

/**
 * Add durationSec to video items (drafts/posts `media` jsonb) from the library, so a
 * platform adapter can refuse a clip over the account's limit up front (tiktok.ts).
 * Best-effort: on any error the media goes out unchanged, as before.
 */
export async function withDurations<M extends { id?: string; mimeType: string }>(media: M[]): Promise<(M & { durationSec?: number })[]> {
  const ids = [...new Set(media.filter((m) => m.id && m.mimeType.startsWith('video/')).map((m) => m.id!))];
  if (!ids.length) return media;
  try {
    const rows = await db().select({ id: mediaAssets.id, d: mediaAssets.durationS }).from(mediaAssets).where(inArray(mediaAssets.id, ids));
    const by = new Map(rows.filter((r) => Number(r.d) > 0).map((r) => [r.id, Number(r.d)]));
    return media.map((m) => (m.id && by.has(m.id) ? { ...m, durationSec: by.get(m.id) } : m));
  } catch {
    return media;
  }
}
