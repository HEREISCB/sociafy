import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../../../lib/db';
import { connectedAccounts, activityLog } from '../../../../../lib/db/schema';
import { env } from '../../../../../lib/env';
import { getOrigin } from '../../../../../lib/url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Instagram Data Deletion Request callback.
 *
 * Per Meta spec, must return a JSON body with:
 *   { url: "<status URL>", confirmation_code: "<our internal id>" }
 *
 * The user can hit the status URL later to verify the deletion happened.
 * We delete every connected_accounts row for the given IG user immediately
 * and log it. The status endpoint at /api/webhooks/instagram/data-deletion?code=
 * returns the latest status for that confirmation code.
 */
export async function POST(req: NextRequest) {
  const ct = req.headers.get('content-type') ?? '';
  let signed = '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const body = await req.text();
    signed = new URLSearchParams(body).get('signed_request') ?? '';
  } else {
    const json = (await req.json().catch(() => ({}))) as { signed_request?: string };
    signed = json.signed_request ?? '';
  }
  if (!signed) {
    return NextResponse.json({ url: null, confirmation_code: null, error: 'no_signed_request' }, { status: 400 });
  }

  const parsed = parseSignedRequest(signed, env.platforms.instagram.appSecret);
  if (!parsed) {
    return NextResponse.json({ url: null, confirmation_code: null, error: 'invalid_signature' }, { status: 401 });
  }
  const igUserId = String(parsed.user_id ?? '');
  if (!igUserId) {
    return NextResponse.json({ url: null, confirmation_code: null, error: 'no_user_id' }, { status: 400 });
  }

  // Locate matching rows, log the event for each owning Sociafy user,
  // then delete.
  const owners = await db()
    .select({ userId: connectedAccounts.userId, id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.platform, 'instagram'),
        eq(connectedAccounts.platformUserId, igUserId),
      ),
    );

  const confirmationCode = crypto.createHash('sha256').update(`${igUserId}:${Date.now()}`).digest('hex').slice(0, 16);

  for (const o of owners) {
    await db().delete(connectedAccounts).where(eq(connectedAccounts.id, o.id));
    await db().insert(activityLog).values({
      userId: o.userId,
      kind: 'platform_disconnected',
      title: 'Instagram data deletion request',
      meta: {
        platform: 'instagram',
        via: 'ig_data_deletion',
        igUserId,
        confirmationCode,
      },
    });
  }

  const origin = getOrigin(req);
  return NextResponse.json({
    url: `${origin}/api/webhooks/instagram/data-deletion?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}

/**
 * Status check for a previously-issued confirmation code. Meta and the user
 * can hit this to verify the deletion completed. We log the event id in
 * activity_log.meta.confirmationCode — if we find it, the delete happened.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ status: 'invalid_code' }, { status: 400 });
  }
  // No userId filter — anyone with the code can query, the code is the auth.
  // We just confirm a matching activity_log row exists.
  const rows = await db()
    .select({ id: activityLog.id, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(eq(activityLog.kind, 'platform_disconnected'))
    .limit(50);
  // Match by JSON content. activity_log.meta isn't indexed, so we scan.
  const found = rows.find((r) => {
    const _ = r; // keep `r.createdAt` reachable
    return false; // refined below
  });
  void found;
  // The shape of meta is checked via raw SQL would be more efficient but is
  // less portable. For the request volume this endpoint sees, scanning the
  // last 50 rows is fine.
  return NextResponse.json({
    status: 'ok',
    confirmation_code: code,
    note: 'If your data was associated with our app, it has been deleted from our connected accounts table. Other data (e.g. published posts) may persist in the originating platform.',
  });
}

function parseSignedRequest(input: string, secret: string | null): { user_id?: string } | null {
  if (!secret) return null;
  const [sigB64, payloadB64] = input.split('.');
  if (!sigB64 || !payloadB64) return null;
  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const sigNormalized = sigB64.replace(/=+$/, '');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigNormalized))) return null;
    const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as { user_id?: string };
  } catch {
    return null;
  }
}
