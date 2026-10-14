import { NextRequest } from 'next/server';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { mediaAssets } from '../../../../lib/db/schema';
import { isStubMode } from '../../../../lib/env';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../../lib/storage/r2';
import { videoDurationSec } from '../../../../lib/media/probe';
import { BRAND_MAX_BYTES, prepareBrandFile } from '../../../../lib/brand/assets';

export const runtime = 'nodejs';
// Multipart bodies can be larger than the default 1MB. Bump generously.
export const maxDuration = 60;

const ACCEPT = /^(image\/(png|jpeg|jpg|webp|gif)|video\/(mp4|quicktime|webm)|audio\/(mpeg|mp3|wav|ogg|webm|m4a|x-m4a|aac))$/i;
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

    // Brand kit files (logos incl. SVG, fonts, PDF guide, screenshots): typed
    // from the bytes, per-type size caps, SVG sanitized — see lib/brand/assets.ts.
    if (form.get('purpose') === 'brand') {
      if (file.size > BRAND_MAX_BYTES) return jsonError('file_too_large', 413, { size: file.size, max: BRAND_MAX_BYTES });
      const prepared = prepareBrandFile(Buffer.from(await file.arrayBuffer()));
      if (!prepared.ok) return jsonError(prepared.error, prepared.status, prepared.max ? { max: prepared.max } : undefined);
      const key = makeMediaKey(user.id, file.name);
      await uploadBuffer({ key, body: prepared.body, contentType: prepared.mime });
      const [row] = await db()
        .insert(mediaAssets)
        .values({
          userId: user.id,
          storageKey: key,
          publicUrl: publicUrlFor(key),
          mimeType: prepared.mime,
          sizeBytes: prepared.body.length,
          label: form.get('label')?.toString().slice(0, 200) || file.name,
        })
        .returning();
      return row;
    }

    if (!ACCEPT.test(file.type)) return jsonError('unsupported_mime', 415, { mime: file.type });
    if (file.size > MAX_BYTES) return jsonError('file_too_large', 413, { size: file.size, max: MAX_BYTES });

    const key = makeMediaKey(user.id, file.name);
    const buf = Buffer.from(await file.arrayBuffer());
    await uploadBuffer({ key, body: buf, contentType: file.type });

    // Duration is billing input, not metadata: reference-video generation is
    // priced per input second, so it has to be derived here from the bytes we
    // received (never from anything the client claims). null = unknown, and
    // consumers on a money path reject rather than guess.
    const durationS = file.type.startsWith('video/') ? videoDurationSec(buf) : null;

    const url = publicUrlFor(key);
    const [row] = await db()
      .insert(mediaAssets)
      .values({
        userId: user.id,
        storageKey: key,
        publicUrl: url,
        mimeType: file.type,
        sizeBytes: file.size,
        durationS: durationS != null ? String(durationS) : null,
        label: form.get('label')?.toString() || file.name,
      })
      .returning();
    return row;
  }, req); // `req` enables withUser's Origin check — without it this POST had no CSRF guard.
}
