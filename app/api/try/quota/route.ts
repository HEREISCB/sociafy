import { NextRequest, NextResponse } from 'next/server';
import { authedUser, jsonError } from '../../../../lib/api';
import { clientIp, hashIp, tryQuota, TRY_PER_DAY, VISITOR_COOKIE } from '../../../../lib/try';

export const runtime = 'nodejs';

/**
 * GET /api/try/quota?kind=image|video — free tries left today for this
 * browser, so the page can say "1 of 2 left" before you spend one. Read-only:
 * counts rows, never writes, never sets the visitor cookie.
 */
export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind');
  if (kind !== 'image' && kind !== 'video') return jsonError('bad_kind', 400);
  const user = await authedUser();
  const { left } = await tryQuota(kind, {
    // A browser that never tried has no cookie yet; this id matches no row.
    visitor: req.cookies.get(VISITOR_COOKIE)?.value ?? 'none',
    ipHash: hashIp(clientIp(req.headers)),
    userId: user?.id ?? null,
  });
  return NextResponse.json({ left, perDay: TRY_PER_DAY[kind] }, { headers: { 'cache-control': 'no-store' } });
}
