import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { isStubMode } from '../../../../lib/env';
import { FOOTAGE_EDIT } from '../../../../lib/ai/models';
import { makeMediaKey, presignPut } from '../../../../lib/storage/r2';

export const runtime = 'nodejs';

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(FOOTAGE_EDIT.mimes),
  size: z.number().int().positive().max(FOOTAGE_EDIT.maxBytes),
});

/**
 * POST /api/media/upload-url {name, type, size} → { url, key }
 * A presigned PUT straight to R2 for a raw clip ("Edit my video"): up to 1 GB, which
 * neither this server's 50 MB upload route nor the CDN in front of it takes. The browser
 * PUTs the file with `Content-Type: type` (signed in, so it must match). The key is in the
 * caller's prefix; /api/media/edit-footage HEADs it before charging, so the size and
 * type claimed here are re-checked against what actually landed.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.r2()) return jsonError('r2_not_configured', 503);
    const rl = rateLimit('general', `upload-url:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const { name, type } = parsed.data;
    const { url, key } = await presignPut({ key: makeMediaKey(user.id, `raw-${name}`), contentType: type, expiresInSeconds: 3_600 });
    return { url, key };
  }, req);
}
