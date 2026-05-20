import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../../../lib/db';
import { connectedAccounts, activityLog } from '../../../../../lib/db/schema';
import { env } from '../../../../../lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Instagram Deauthorize callback.
 *
 * Triggered when a user removes Sociafy from their Instagram account
 * settings. Meta POSTs a `signed_request` form field encoded as
 * "<base64 sig>.<base64 payload>" — verify the HMAC signature with the
 * app secret, then drop the matching row.
 *
 * Per Meta docs: respond 200 OK even if we can't locate the user, so
 * Meta doesn't retry forever.
 */
export async function POST(req: NextRequest) {
  const ct = req.headers.get('content-type') ?? '';
  let signed = '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const body = await req.text();
    const params = new URLSearchParams(body);
    signed = params.get('signed_request') ?? '';
  } else if (ct.includes('application/json')) {
    const json = (await req.json().catch(() => ({}))) as { signed_request?: string };
    signed = json.signed_request ?? '';
  }
  if (!signed) {
    return NextResponse.json({ ok: false, error: 'no_signed_request' }, { status: 400 });
  }

  const parsed = parseSignedRequest(signed, env.platforms.meta.appSecret);
  if (!parsed) {
    return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });
  }
  const igUserId = String(parsed.user_id ?? '');
  if (!igUserId) {
    return NextResponse.json({ ok: true, dropped: 0 });
  }

  // Delete any connected_accounts row for this IG user; log the event for
  // any user that owned it so their UI updates on next refresh.
  const owners = await db()
    .select({ userId: connectedAccounts.userId, id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.platform, 'instagram'),
        eq(connectedAccounts.platformUserId, igUserId),
      ),
    );

  for (const o of owners) {
    await db().delete(connectedAccounts).where(eq(connectedAccounts.id, o.id));
    await db().insert(activityLog).values({
      userId: o.userId,
      kind: 'platform_disconnected',
      title: 'Instagram revoked by user',
      meta: { platform: 'instagram', via: 'ig_deauth_callback', igUserId },
    });
  }

  return NextResponse.json({ ok: true, dropped: owners.length });
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
      // Meta uses base64url (no padding) in their signed_request format.
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
