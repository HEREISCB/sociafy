import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { activityLog, connectedAccounts } from '../../../../lib/db/schema';
import { env } from '../../../../lib/env';
import { rateLimit, requestIp } from '../../../../lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Instagram webhook handler — dedicated to the "Instagram API with Instagram
 * Login" product. The FB-side webhook at /api/webhooks/meta handles the
 * Facebook Login flow; this one handles direct IG Login subscriptions.
 *
 * Setup in Meta dashboard:
 *   App → Instagram product → Webhooks → set Callback URL to this route's
 *   URL and Verify Token to env.platforms.meta.webhookVerifyToken. Subscribe
 *   to the `instagram` object with the fields you care about (comments,
 *   mentions, messages, live_comments, etc.).
 *
 * Protocol:
 *   GET  ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...  → echo challenge
 *   POST events signed with X-Hub-Signature-256 = sha256(rawBody, app_secret)
 */

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  const expected = env.platforms.meta.webhookVerifyToken;
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: 'verify_failed' }, { status: 403 });
}

function verifySignature(rawBody: string, header: string | null): boolean {
  if (!env.platforms.meta.appSecret) return false;
  if (!header) return false;
  const expected = `sha256=${crypto
    .createHmac('sha256', env.platforms.meta.appSecret)
    .update(rawBody)
    .digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

type InstagramEvent = {
  object?: 'instagram';
  entry?: Array<{
    id: string;
    time?: number;
    changes?: Array<{ field: string; value: Record<string, unknown> }>;
    messaging?: Array<Record<string, unknown>>;
  }>;
};

export async function POST(req: NextRequest) {
  const rl = rateLimit('webhook', `ig:${requestIp(req.headers)}`);
  if (!rl.ok) {
    return new NextResponse('rate_limited', { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } });
  }
  const rawBody = await req.text();
  const signature = req.headers.get('x-hub-signature-256');
  const verified = verifySignature(rawBody, signature);

  console.log('[ig-webhook]', { verified, bodyLen: rawBody.length });

  if (!verified) {
    return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });
  }

  let payload: InstagramEvent = {};
  try {
    payload = JSON.parse(rawBody) as InstagramEvent;
  } catch {
    return NextResponse.json({ ok: true, parsed: false });
  }

  // Only process Instagram events on this endpoint. Anything else is a
  // misconfiguration (someone pointed an FB webhook here) and silently dropped.
  if (payload.object !== 'instagram') {
    return NextResponse.json({ ok: true, ignored: payload.object ?? 'unknown' });
  }

  const entries = payload.entry ?? [];
  const eventId = crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
  let logged = 0;

  for (const entry of entries) {
    // entry.id is the IG Business user_id — same value we stored as
    // connected_accounts.platform_user_id when the user OAuth'd.
    const rows = await db()
      .select({ userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.platform, 'instagram'),
          eq(connectedAccounts.platformUserId, entry.id),
        ),
      )
      .limit(1);
    const userId = rows[0]?.userId;
    if (!userId) continue;

    // Idempotency: dedup by raw body hash so retries don't double-insert.
    const recent = await db()
      .select({ id: activityLog.id, meta: activityLog.meta })
      .from(activityLog)
      .where(and(eq(activityLog.userId, userId), eq(activityLog.kind, 'webhook_event')))
      .orderBy(desc(activityLog.createdAt))
      .limit(50);
    const dup = recent.some((r) => {
      const m = r.meta as { eventId?: unknown } | null;
      return m && typeof m.eventId === 'string' && m.eventId === eventId;
    });
    if (dup) continue;

    const fields = (entry.changes ?? []).map((c) => c.field).join(', ')
      || (entry.messaging ? 'messaging' : 'event');

    await db().insert(activityLog).values({
      userId,
      kind: 'webhook_event',
      title: `Instagram · ${fields}`,
      meta: { platform: 'instagram', entry, verified: true, eventId },
    });
    logged += 1;
  }

  return NextResponse.json({ ok: true, entries: entries.length, logged });
}
