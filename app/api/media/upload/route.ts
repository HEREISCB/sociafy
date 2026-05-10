import { NextRequest } from 'next/server';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { mediaAssets } from '../../../../lib/db/schema';
import { isStubMode } from '../../../../lib/env';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../../lib/storage/r2';

export const runtime = 'nodejs';
// Multipart bodies can be larger than the default 1MB. Bump generously.
export const maxDuration = 60;

const ACCEPT = /^(image\/(png|jpeg|jpg|webp|gif)|video\/(mp4|quicktime|webm))$/i;
const MAX_BYTES = 50 * 1024 * 1024; // 50MB cap for MVP

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (isStubMode.r2()) {
      return jsonError('r2_not_configured', 503, {
        hint: 'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, NEXT_PUBLIC_R2_PUBLIC_URL_BASE.',
      });
    }
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return jsonError('file_required');
    if (!ACCEPT.test(file.type)) return jsonError('unsupported_mime', 415, { mime: file.type });
    if (file.size > MAX_BYTES) return jsonError('file_too_large', 413, { size: file.size, max: MAX_BYTES });

    const key = makeMediaKey(user.id, file.name);
    const buf = Buffer.from(await file.arrayBuffer());
    await uploadBuffer({ key, body: buf, contentType: file.type });

    const url = publicUrlFor(key);
    const [row] = await db()
      .insert(mediaAssets)
      .values({
        userId: user.id,
        storageKey: key,
        publicUrl: url,
        mimeType: file.type,
        sizeBytes: file.size,
        label: form.get('label')?.toString() || file.name,
      })
      .returning();
    return row;
  });
}
