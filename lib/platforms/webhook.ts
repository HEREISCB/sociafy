import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
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
  if (mode === 'subscribe' && expected && token && safeHmacEq(expected, token) && challenge) {
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
// Instagram (direct IG Login product) — same X-Hub-Signature-256 scheme.
// Meta's docs only say "your app's App Secret"
// (https://developers.facebook.com/docs/instagram-platform/webhooks) without
// saying whether that's the Instagram app secret or the Meta app secret, so
// a signature valid under EITHER is accepted. Only accepts
// `payload.object === 'instagram'`; anything else is dropped as a
// misconfigured endpoint.
// ----------------------------------------------------------------------------

export const instagramWebhookAdapter: WebhookAdapter = {
  id: 'instagram',
  isConfigured: () => !!env.platforms.instagram.appSecret || !!env.platforms.meta.appSecret,
  challenge: metaChallenge,
  verify({ rawBody, headers }) {
    const sig = headers.get('x-hub-signature-256');
    // Evaluate both (no short-circuit) so timing doesn't reveal which matched.
    const ig = metaXHubVerify(env.platforms.instagram.appSecret, rawBody, sig);
    const meta = metaXHubVerify(env.platforms.meta.appSecret, rawBody, sig);
    return ig || meta;
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
// Meta signed_request (deauthorize + data-deletion callbacks):
// "<base64url sig>.<base64url payload>", HMAC-SHA256 of the payload segment.
// https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
// ----------------------------------------------------------------------------

export function parseSignedRequest(input: string, secret: string | null): { user_id?: string } | null {
  if (!secret) return null;
  const [sigB64, payloadB64] = input.split('.');
  if (!sigB64 || !payloadB64) return null;
  try {
    const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    // Accept both base64url and padded/standard base64 signatures.
    const sigNormalized = sigB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!safeHmacEq(expected, sigNormalized)) return null;
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as { user_id?: string };
  } catch {
    return null;
  }
}

/** Read `signed_request` from a form or JSON body. */
export async function readSignedRequest(req: NextRequest): Promise<string> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(await req.text()).get('signed_request') ?? '';
  }
  const json = (await req.json().catch(() => ({}))) as { signed_request?: string };
  return json.signed_request ?? '';
}

/**
 * Data-deletion confirmation codes are self-verifying: nonce + HMAC(nonce).
 * The status endpoint can then answer "completed" for a code we issued even
 * when there was nothing to delete (so no activity_log row was written).
 */
export function issueDeletionCode(secret: string): string {
  const nonce = crypto.randomBytes(8).toString('hex');
  return nonce + crypto.createHmac('sha256', secret).update(nonce).digest('hex').slice(0, 16);
}

export function isIssuedDeletionCode(code: string, secret: string | null): boolean {
  if (!secret || code.length !== 32) return false;
  const nonce = code.slice(0, 16);
  return safeHmacEq(crypto.createHmac('sha256', secret).update(nonce).digest('hex').slice(0, 16), code.slice(16));
}

/** Config for a Meta deauthorize / data-deletion callback pair. */
export type MetaCallbackConfig = {
  platform: 'instagram' | 'facebook';
  label: string;
  /** Secrets the signed_request may be signed with, tried in order. */
  secrets: Array<string | null>;
  /** tokens.meta key holding the id Meta puts in signed_request.user_id
   *  (besides platformUserId). */
  metaIdKey: string;
  deauthVia: string;
  deletionVia: string;
};

// IG Login signed_requests use the Instagram app secret; the Meta app secret
// is a fallback since Meta's docs don't pin which one. The id may be the IG
// user_id (platformUserId) or the app-scoped /me id (meta.igScopedId).
export const instagramCallbackConfig: MetaCallbackConfig = {
  platform: 'instagram',
  label: 'Instagram',
  secrets: [env.platforms.instagram.appSecret, env.platforms.meta.appSecret],
  metaIdKey: 'igScopedId',
  deauthVia: 'ig_deauth_callback',
  deletionVia: 'ig_data_deletion',
};

// Facebook Login signed_requests carry the app-scoped USER id (meta.userId);
// platformUserId is the Page id.
export const facebookCallbackConfig: MetaCallbackConfig = {
  platform: 'facebook',
  label: 'Facebook',
  secrets: [env.platforms.meta.appSecret],
  metaIdKey: 'userId',
  deauthVia: 'fb_deauth_callback',
  deletionVia: 'fb_data_deletion',
};

function parseWithAny(signed: string, secrets: Array<string | null>) {
  for (const s of secrets) {
    const parsed = parseSignedRequest(signed, s);
    if (parsed) return parsed;
  }
  return null;
}

function findAccountsForSignedUser(cfg: MetaCallbackConfig, userId: string) {
  return db()
    .select({
      userId: connectedAccounts.userId,
      id: connectedAccounts.id,
      platformUserId: connectedAccounts.platformUserId,
      handle: connectedAccounts.handle,
      meta: connectedAccounts.meta,
    })
    .from(connectedAccounts)
    .where(and(
      eq(connectedAccounts.platform, cfg.platform),
      or(
        eq(connectedAccounts.platformUserId, userId),
        sql`${connectedAccounts.meta} ->> ${cfg.metaIdKey} = ${userId}`,
      ),
    ));
}

/** Deauthorize callback. Responds 200 even when no account matched so Meta
 *  doesn't retry forever. */
export async function handleDeauthCallback(req: NextRequest, cfg: MetaCallbackConfig): Promise<NextResponse> {
  const signed = await readSignedRequest(req);
  if (!signed) return NextResponse.json({ ok: false, error: 'no_signed_request' }, { status: 400 });
  const parsed = parseWithAny(signed, cfg.secrets);
  if (!parsed) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });
  const signedUserId = String(parsed.user_id ?? '');
  if (!signedUserId) return NextResponse.json({ ok: true, dropped: 0 });

  const owners = await findAccountsForSignedUser(cfg, signedUserId);
  for (const o of owners) {
    await db().delete(connectedAccounts).where(eq(connectedAccounts.id, o.id));
    await db().insert(activityLog).values({
      userId: o.userId,
      kind: 'platform_disconnected',
      title: `${cfg.label} revoked by user`,
      meta: { platform: cfg.platform, via: cfg.deauthVia, signedUserId },
    });
  }
  return NextResponse.json({ ok: true, dropped: owners.length });
}

/**
 * Data Deletion Request callback. Meta requires a JSON response
 * { url, confirmation_code }:
 * https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 *
 * Deletes the connected_accounts row(s) plus activity_log rows clearly tied
 * to that account: webhook_event rows whose payload entry id is one of the
 * account's ids, and platform_connected rows for the same platform + handle.
 */
export async function handleDataDeletionCallback(
  req: NextRequest,
  cfg: MetaCallbackConfig,
  statusUrl: string,
): Promise<NextResponse> {
  const signed = await readSignedRequest(req);
  if (!signed) {
    return NextResponse.json({ url: null, confirmation_code: null, error: 'no_signed_request' }, { status: 400 });
  }
  const parsed = parseWithAny(signed, cfg.secrets);
  if (!parsed) {
    return NextResponse.json({ url: null, confirmation_code: null, error: 'invalid_signature' }, { status: 401 });
  }
  const signedUserId = String(parsed.user_id ?? '');
  if (!signedUserId) {
    return NextResponse.json({ url: null, confirmation_code: null, error: 'no_user_id' }, { status: 400 });
  }

  const confirmationCode = issueDeletionCode(cfg.secrets.find(Boolean)!);
  const owners = await findAccountsForSignedUser(cfg, signedUserId);
  for (const o of owners) {
    const ids = [o.platformUserId, o.meta?.[cfg.metaIdKey], signedUserId]
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    await db().delete(activityLog).where(and(
      eq(activityLog.userId, o.userId),
      sql`${activityLog.meta} ->> 'platform' = ${cfg.platform}`,
      or(
        and(
          eq(activityLog.kind, 'webhook_event'),
          inArray(sql`${activityLog.meta} -> 'payload' -> 'entry' ->> 'id'`, ids),
        ),
        o.handle
          ? and(eq(activityLog.kind, 'platform_connected'), sql`${activityLog.meta} ->> 'handle' = ${o.handle}`)
          : undefined,
      ),
    ));
    await db().delete(connectedAccounts).where(eq(connectedAccounts.id, o.id));
    await db().insert(activityLog).values({
      userId: o.userId,
      kind: 'platform_disconnected',
      title: `${cfg.label} data deletion request`,
      meta: { platform: cfg.platform, via: cfg.deletionVia, signedUserId, confirmationCode },
    });
  }

  return NextResponse.json({
    url: `${statusUrl}?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}

/**
 * Status check for a confirmation code. Deletion runs synchronously in the
 * POST, so any code we issued is complete — including ones where nothing
 * matched (no activity_log row exists then, hence the HMAC check). The code
 * itself is the authorization; nothing user-identifying is returned.
 */
export async function handleDataDeletionStatus(req: NextRequest, cfg: MetaCallbackConfig): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get('code');
  // Defensive bound so we can't be tricked into expensive scans.
  if (!code || code.length > 64 || !/^[a-f0-9]+$/i.test(code)) {
    return NextResponse.json({ status: 'invalid_code' }, { status: 400 });
  }
  const [row] = await db()
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(and(
      eq(activityLog.kind, 'platform_disconnected'),
      sql`${activityLog.meta} ->> 'confirmationCode' = ${code}`,
      sql`${activityLog.meta} ->> 'via' = ${cfg.deletionVia}`,
    ))
    .limit(1);

  if (!row && !cfg.secrets.some((s) => isIssuedDeletionCode(code, s))) {
    return NextResponse.json({
      status: 'not_found',
      confirmation_code: code,
      note: 'No deletion request matched this code.',
    });
  }
  return NextResponse.json({
    status: 'completed',
    confirmation_code: code,
    ...(row ? { completed_at: row.createdAt } : {}),
    note: `Your ${cfg.label} connection data was deleted from Sociafy. Content already published on ${cfg.label} is not affected.`,
  });
}

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
