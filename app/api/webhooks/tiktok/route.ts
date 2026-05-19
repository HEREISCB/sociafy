import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { activityLog, connectedAccounts } from '../../../../lib/db/schema';
import { env } from '../../../../lib/env';
import { rateLimit, requestIp } from '../../../../lib/rate-limit';

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

// 5 minute window — anything older is a replay attempt.
const REPLAY_WINDOW_S = 300;

function verifySignature(rawBody: string, timestamp: string | null, signature: string | null): boolean {
  if (!env.platforms.tiktok.clientSecret) return false;
  if (!timestamp || !signature) return false;
  // Reject stale timestamps to defeat replays of captured signed events.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_S) return false;
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
  const rl = rateLimit('webhook', `tiktok:${requestIp(req.headers)}`);
  if (!rl.ok) {
    return new NextResponse('rate_limited', { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } });
  }
  const rawBody = await req.text();
  const timestamp = req.headers.get('tt-timestamp');
  const signature = req.headers.get('tt-signature');
  const verified = verifySignature(rawBody, timestamp, signature);

  console.log('[tiktok-webhook]', { verified, ts: timestamp, bodyLen: rawBody.length });

  // Reject unverified bodies — never read or persist them.
  // In dev with no client secret configured, accept (verified=false is acceptable)
  // so platform-setup pings work, but skip the DB insert.
  if (!verified && env.platforms.tiktok.clientSecret) {
    return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });
  }

  let payload: TikTokEvent = {};
  try {
    payload = JSON.parse(rawBody) as TikTokEvent;
  } catch {
    return NextResponse.json({ ok: true, parsed: false });
  }

  const eventName = payload.event ?? 'unknown';
  const openId = payload.user_openid;

  // Build a stable idempotency key so retries don't double-insert.
  const eventId = makeEventId(rawBody);

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

  if (userId && verified) {
    const already = await alreadyLogged(userId, eventId);
    if (!already) {
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
          eventId,
          content: payload.content ?? null,
        },
      });
    }
  }

  return NextResponse.json({ ok: true, verified, event: eventName, mapped: !!userId });
}

function makeEventId(rawBody: string): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
}

async function alreadyLogged(userId: string, eventId: string): Promise<boolean> {
  // Cheap dedup: scan recent webhook_event rows for this user, compare eventId in meta.
  // Keeps things simple without an extra index; activity_log already has (user_id, created_at).
  const recent = await db()
    .select({ id: activityLog.id, meta: activityLog.meta })
    .from(activityLog)
    .where(and(eq(activityLog.userId, userId), eq(activityLog.kind, 'webhook_event')))
    .orderBy(desc(activityLog.createdAt))
    .limit(50);
  return recent.some((r) => {
    const m = r.meta as { eventId?: unknown } | null;
    return m && typeof m.eventId === 'string' && m.eventId === eventId;
  });
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
