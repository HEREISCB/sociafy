import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { activityLog, connectedAccounts, type Platform } from '../db/schema';
import { env } from '../env';
import { rateLimit, requestIp } from '../rate-limit';
import type { WebhookAdapter, WebhookEvent } from './types';

/**
 * Shared webhook plumbing. Each platform implements a WebhookAdapter that
 * owns its signature scheme, challenge handshake, and event parsing; the
 * route handlers stay one-liners that hand the request to handleWebhookGet
 * / handleWebhookPost below.
 *
 * The handler is responsible for the parts every platform does the same way:
 * rate limiting, persisting events to activity_log keyed by (userId, kind=
 * 'webhook_event'), and idempotency via eventId scanned over the last 50 rows.
 */

function eventIdFor(rawBody: string): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
}

function safeHmacEq(expected: string, actual: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// TikTok — HMAC-SHA256 over `${timestamp}${rawBody}` keyed by client_secret.
// 5-minute timestamp window defeats captured-event replays.
// ----------------------------------------------------------------------------

const TIKTOK_REPLAY_WINDOW_S = 300;

type TikTokEvent = {
  client_key?: string;
  event?: string;
  create_time?: number;
  user_openid?: string;
  content?: unknown;
};

function tiktokPretty(name: string): string {
  return name.replace(/^./, (c) => c.toUpperCase()).replace(/\./g, ' · ').replace(/_/g, ' ');
}

function tiktokSummary(payload: TikTokEvent): string {
  const c = payload.content;
  if (!c || typeof c !== 'object') return '';
  const obj = c as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof obj.publish_id === 'string') bits.push(`publish_id=${obj.publish_id}`);
  if (typeof obj.status === 'string') bits.push(`status=${obj.status}`);
  if (typeof obj.fail_reason === 'string') bits.push(`reason=${obj.fail_reason}`);
  return bits.join(' · ');
}

export const tiktokWebhookAdapter: WebhookAdapter = {
  id: 'tiktok',
  isConfigured: () => !!env.platforms.tiktok.clientSecret,
  challenge(searchParams) {
    // Some TikTok setups send a `challenge` query parameter expected to be
    // echoed back during URL verification.
    return searchParams.get('challenge');
  },
  verify({ rawBody, headers }) {
    const secret = env.platforms.tiktok.clientSecret;
    if (!secret) return false;
    const timestamp = headers.get('tt-timestamp');
    const signature = headers.get('tt-signature');
    if (!timestamp || !signature) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TIKTOK_REPLAY_WINDOW_S) return false;
    const mac = crypto.createHmac('sha256', secret).update(`${timestamp}${rawBody}`).digest('hex');
    return safeHmacEq(mac, signature);
  },
  parse(rawBody) {
    let payload: TikTokEvent;
    try {
      payload = JSON.parse(rawBody) as TikTokEvent;
    } catch {
      return [];
    }
    const eventName = payload.event ?? 'unknown';
    return [{
      platform: 'tiktok',
      eventId: eventIdFor(rawBody),
      platformUserId: payload.user_openid,
      title: `TikTok · ${tiktokPretty(eventName)}`,
      body: tiktokSummary(payload),
      payload,
    }];
  },
};

// ----------------------------------------------------------------------------
// Meta (Facebook + Instagram via FB Login) — HMAC-SHA256 over rawBody keyed
// by META_APP_SECRET. The endpoint can receive both `page` (Facebook) and
// `instagram` events; parse() emits one normalized event per `entry`.
// ----------------------------------------------------------------------------

type MetaEvent = {
  object?: 'page' | 'instagram' | 'user';
  entry?: Array<{
    id: string;
    time?: number;
    changes?: Array<{ field: string; value: Record<string, unknown> }>;
    messaging?: Array<Record<string, unknown>>;
  }>;
};

function metaChallenge(searchParams: URLSearchParams): string | null {
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');
  const expected = env.platforms.meta.webhookVerifyToken;
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return challenge;
  }
  return null;
}

function metaXHubVerify(secret: string | null, rawBody: string, header: string | null): boolean {
  if (!secret || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeHmacEq(expected, header);
}

export const metaWebhookAdapter: WebhookAdapter = {
  id: 'meta',
  isConfigured: () => !!env.platforms.meta.appSecret,
  challenge: metaChallenge,
  verify({ rawBody, headers }) {
    return metaXHubVerify(env.platforms.meta.appSecret, rawBody, headers.get('x-hub-signature-256'));
  },
  parse(rawBody) {
    let payload: MetaEvent;
    try {
      payload = JSON.parse(rawBody) as MetaEvent;
    } catch {
      return [];
    }
    const platformKey: Platform = payload.object === 'instagram' ? 'instagram' : 'facebook';
    const entries = payload.entry ?? [];
    const eventId = eventIdFor(rawBody);
    return entries.map((entry, idx) => {
      const fields = (entry.changes ?? []).map((c) => c.field).join(', ')
        || (entry.messaging ? 'messaging' : 'event');
      return {
        platform: platformKey,
        // Per-entry idempotency key keeps multi-entry payloads from collapsing
        // into a single activity_log row.
        eventId: entries.length > 1 ? `${eventId}:${idx}` : eventId,
        platformUserId: entry.id,
        title: `${platformKey === 'instagram' ? 'Instagram' : 'Facebook'} · ${fields}`,
        payload: { entry, object: payload.object },
      };
    });
  },
};

// ----------------------------------------------------------------------------
// Instagram (direct IG Login product) — same X-Hub-Signature-256 scheme,
// but signed with INSTAGRAM_APP_SECRET (separate from META_APP_SECRET).
// Only accepts `payload.object === 'instagram'`; anything else is dropped
// as a misconfigured endpoint.
// ----------------------------------------------------------------------------

export const instagramWebhookAdapter: WebhookAdapter = {
  id: 'instagram',
  isConfigured: () => !!env.platforms.instagram.appSecret,
  challenge: metaChallenge,
  verify({ rawBody, headers }) {
    return metaXHubVerify(env.platforms.instagram.appSecret, rawBody, headers.get('x-hub-signature-256'));
  },
  parse(rawBody) {
    let payload: MetaEvent;
    try {
      payload = JSON.parse(rawBody) as MetaEvent;
    } catch {
      return [];
    }
    if (payload.object !== 'instagram') return [];
    const entries = payload.entry ?? [];
    const eventId = eventIdFor(rawBody);
    return entries.map((entry, idx) => {
      const fields = (entry.changes ?? []).map((c) => c.field).join(', ')
        || (entry.messaging ? 'messaging' : 'event');
      return {
        platform: 'instagram',
        eventId: entries.length > 1 ? `${eventId}:${idx}` : eventId,
        platformUserId: entry.id,
        title: `Instagram · ${fields}`,
        payload: { entry, object: payload.object },
      };
    });
  },
};

// ----------------------------------------------------------------------------
// Shared route handlers — the per-platform route files call these.
// ----------------------------------------------------------------------------

export function handleWebhookGet(req: NextRequest, adapter: WebhookAdapter): NextResponse {
  const challenge = adapter.challenge?.(req.nextUrl.searchParams);
  if (challenge) return new NextResponse(challenge, { status: 200 });
  return NextResponse.json({ ok: true, service: `${adapter.id}-webhook` });
}

export async function handleWebhookPost(req: NextRequest, adapter: WebhookAdapter): Promise<NextResponse> {
  const rl = rateLimit('webhook', `${adapter.id}:${requestIp(req.headers)}`);
  if (!rl.ok) {
    return new NextResponse('rate_limited', { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } });
  }
  const rawBody = await req.text();
  const configured = adapter.isConfigured();
  const verified = configured && adapter.verify({ rawBody, headers: req.headers });

  console.log(`[${adapter.id}-webhook]`, { verified, configured, bodyLen: rawBody.length });

  // Accept unverified bodies only when the platform isn't configured at all —
  // that's the dev/setup-ping case. Once configured, an invalid signature is
  // a hard 401 and we never read the body.
  if (configured && !verified) {
    return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });
  }
  if (!configured) {
    return NextResponse.json({ ok: true, verified: false, stub: true });
  }

  const events = adapter.parse(rawBody);
  let logged = 0;
  for (const event of events) {
    if (await persistWebhookEvent(event)) logged++;
  }
  return NextResponse.json({ ok: true, events: events.length, logged });
}

async function persistWebhookEvent(event: WebhookEvent): Promise<boolean> {
  if (!event.platformUserId) return false;
  const rows = await db()
    .select({ userId: connectedAccounts.userId })
    .from(connectedAccounts)
    .where(and(
      eq(connectedAccounts.platform, event.platform),
      eq(connectedAccounts.platformUserId, event.platformUserId),
    ))
    .limit(1);
  const userId = rows[0]?.userId;
  if (!userId) return false;

  // Idempotency: scan the user's recent webhook_event rows for the same
  // eventId. activity_log already has (user_id, created_at) which makes
  // this cheap; no extra index needed.
  const recent = await db()
    .select({ id: activityLog.id, meta: activityLog.meta })
    .from(activityLog)
    .where(and(eq(activityLog.userId, userId), eq(activityLog.kind, 'webhook_event')))
    .orderBy(desc(activityLog.createdAt))
    .limit(50);
  const dup = recent.some((r) => {
    const m = r.meta as { eventId?: unknown } | null;
    return m && typeof m.eventId === 'string' && m.eventId === event.eventId;
  });
  if (dup) return false;

  await db().insert(activityLog).values({
    userId,
    kind: 'webhook_event',
    title: event.title,
    body: event.body,
    meta: {
      platform: event.platform,
      verified: true,
      eventId: event.eventId,
      payload: event.payload,
    },
  });
  return true;
}
