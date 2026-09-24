import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { tryGenerations } from '../../../../lib/db/schema';
import { authedUser, jsonError } from '../../../../lib/api';
import { advanceVideoTry, claimTry, tryView, VISITOR_COOKIE } from '../../../../lib/try';

export const runtime = 'nodejs';
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/try/:id — status poll. Advances a finished video, and when the
 * visitor has since signed in, hands the generation to their account.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return jsonError('not_found', 404);
  const load = async () => (await db().select().from(tryGenerations).where(eq(tryGenerations.id, id)).limit(1))[0];
  let row = await load();
  if (!row) return jsonError('not_found', 404);

  if (row.kind === 'video' && row.status !== 'ready' && row.status !== 'failed') {
    await advanceVideoTry(row).catch((e) => console.error('[try] advance failed', id, e));
    row = (await load()) ?? row;
  }
  const user = await authedUser();
  if (user) row = await claimTry(row, user.id, req.cookies.get(VISITOR_COOKIE)?.value);
  return NextResponse.json(tryView(row, user?.id ?? null), { headers: { 'cache-control': 'no-store' } });
}
