import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { activityLog, connectedAccounts } from '../../../../lib/db/schema';
import { env } from '../../../../lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// TikTok pings a GET on the URL to verify reachability during setup —
// some flows also send a `challenge` query param to be echoed back.
export async function GET(req: NextRequest) {
  const challenge = req.nextUrl.searchParams.get('challenge');
  if (challenge) return new NextResponse(challenge, { status: 200 });
  return NextResponse.json({ ok: true, service: 'tiktok-webhook' });
}

// Event payload (shape varies by event type, so we type loosely).
type TikTokEvent = {
  client_key?: string;
  event?: string;
  create_time?: number;
  user_openid?: string;
  content?: unknown;
};

function verifySignature(rawBody: string, timestamp: string | null, signature: string | null): boolean {
  if (!env.platforms.tiktok.clientSecret) return false;
  if (!timestamp || !signature) return false;
  const mac = crypto
    .createHmac('sha256', env.platforms.tiktok.clientSecret)
    .update(`${timestamp}${rawBody}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const timestamp = req.headers.get('tt-timestamp');
  const signature = req.headers.get('tt-signature');
  const verified = verifySignature(rawBody, timestamp, signature);

  console.log('[tiktok-webhook]', {
    verified,
    ts: timestamp,
    bodyLen: rawBody.length,
  });

  let payload: TikTokEvent = {};
  try {
    payload = JSON.parse(rawBody) as TikTokEvent;
  } catch {
    // Body was not JSON — still ack with 200 so TikTok doesn't retry, but log.
    return NextResponse.json({ ok: true, parsed: false });
  }

  const eventName = payload.event ?? 'unknown';
  const openId = payload.user_openid;

  // Map event back to a Sociafy user via the connected_accounts row.
  let userId: string | null = null;
  if (openId) {
    const rows = await db()
      .select({ userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.platform, 'tiktok'),
          eq(connectedAccounts.platformUserId, openId),
        ),
      )
      .limit(1);
    userId = rows[0]?.userId ?? null;
  }

  if (userId) {
    await db().insert(activityLog).values({
      userId,
      kind: 'webhook_event',
      title: `TikTok · ${prettyEvent(eventName)}`,
      body: summarize(payload),
      meta: {
        platform: 'tiktok',
        event: eventName,
        verified,
        openId,
        content: payload.content ?? null,
      },
    });
  }

  return NextResponse.json({ ok: true, verified, event: eventName, mapped: !!userId });
}

function prettyEvent(name: string): string {
  return name
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\./g, ' · ')
    .replace(/_/g, ' ');
}

function summarize(payload: TikTokEvent): string {
  const c = payload.content;
  if (!c || typeof c !== 'object') return '';
  const obj = c as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof obj.publish_id === 'string') bits.push(`publish_id=${obj.publish_id}`);
  if (typeof obj.status === 'string') bits.push(`status=${obj.status}`);
  if (typeof obj.fail_reason === 'string') bits.push(`reason=${obj.fail_reason}`);
  return bits.join(' · ');
}
