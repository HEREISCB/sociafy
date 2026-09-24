import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../../lib/db';
import { tryGenerations } from '../../../../../lib/db/schema';
import { authedUser, jsonError } from '../../../../../lib/api';
import { publicUrlFor } from '../../../../../lib/storage/r2';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/try/:id/download — the clean, watermark-free file as an attachment.
 * Owner only. Same-origin so the browser really downloads it (the `download`
 * attribute is ignored on cross-origin R2 links).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return jsonError('not_found', 404);
  const user = await authedUser();
  if (!user) return jsonError('unauthorized', 401);
  const [row] = await db().select().from(tryGenerations).where(eq(tryGenerations.id, id)).limit(1);
  if (!row || row.claimedBy !== user.id || row.status !== 'ready' || !row.originalKey) return jsonError('not_found', 404);

  const upstream = await fetch(publicUrlFor(row.originalKey));
  if (!upstream.ok || !upstream.body) return jsonError('unavailable', 502);
  const ext = row.kind === 'image' ? 'png' : 'mp4';
  return new Response(upstream.body, {
    headers: {
      'content-type': row.kind === 'image' ? 'image/png' : 'video/mp4',
      'content-disposition': `attachment; filename="sociafy-${row.kind}-${id.slice(0, 8)}.${ext}"`,
      ...(upstream.headers.get('content-length') ? { 'content-length': upstream.headers.get('content-length')! } : {}),
      'cache-control': 'private, no-store',
    },
  });
}
