import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../../lib/api';
import { parseBody } from '../../../../../lib/validation';
import { rateLimit } from '../../../../../lib/rate-limit';
import { isStubMode } from '../../../../../lib/env';
import { db } from '../../../../../lib/db';
import { mediaAssets } from '../../../../../lib/db/schema';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../../../lib/storage/r2';
import { fetchReferenceImages } from '../../../v1/shared';

export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  imageUrls: z.array(z.string().url().max(2_000)).min(1).max(4),
  label: z.string().trim().max(120).optional(),
});

/**
 * POST /api/media/from-url/import { imageUrls, label? } → 200 { items: media_assets rows }
 * Copies a product's website photos into the user's library so Compose can
 * attach them to a post (drafts only carry library media). Free. Every URL goes
 * through fetchReferenceImages: https only, public hosts, real image bytes, size caps.
 * Photos that fail those checks are skipped; only if all fail is it an error.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.r2()) return jsonError('r2_not_configured', 503);
    const rl = rateLimit('general', `fromurl-import:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;

    // Each photo on its own, so a single dead or oversized one doesn't sink the others.
    const fetched = await Promise.all(parsed.data.imageUrls.map((u) => fetchReferenceImages([u])));
    const files = fetched.flatMap((f) => (f.ok ? f.files : []));
    if (!files.length) {
      const first = fetched.find((f) => !f.ok);
      return first && !first.ok ? first.response : jsonError('images_unavailable', 422);
    }
    const items = await Promise.all(files.map(async (file) => {
      const key = makeMediaKey(user.id, file.name);
      await uploadBuffer({ key, body: Buffer.from(await file.arrayBuffer()), contentType: file.type });
      const [row] = await db().insert(mediaAssets).values({
        userId: user.id, storageKey: key, publicUrl: publicUrlFor(key), mimeType: file.type, sizeBytes: file.size,
        label: parsed.data.label || file.name,
      }).returning();
      return row;
    }));
    return { items };
  }, req);
}
