/**
 * Developer API-key auth for the public metered /api/v1 surface.
 *
 * A key maps to a Clerk userId, so an external developer is just a profiles
 * row and credits / ledger / refunds / storage namespacing work unchanged.
 *
 * Hashing is SHA-256, deliberately not bcrypt/argon: the key is 32 bytes of
 * CSPRNG output, so there is no dictionary to stretch against, and auth must
 * be one *indexed* lookup per request — a slow salted hash would force a full
 * table scan. lib/crypto/tokens.ts is reversible AES (for OAuth tokens we must
 * replay); API keys must be one-way, so it is not reused here.
 */

import crypto from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './db';
import { apiKeys, creditLedger } from './db/schema';
import { ensureProfile } from './api';
import { InsufficientCreditsError, insufficientCreditsResponse } from './credits/ledger';

export type ApiKeyAuth = { userId: string; apiKeyId: string };

/** Namespaced on purpose. `sk_live_` is Stripe's secret-key format, and secret
 *  scanners match on it — GitHub push protection blocks a commit containing one,
 *  so that prefix would get our own customers' pushes rejected and misattribute
 *  our keys to Stripe during leak triage. */
const PREFIX = 'sfy_live_';
/** Chars of the plaintext stored for display/support: the prefix + 6 random.
 *  Derived, so it can't drift if the prefix is ever renamed again. */
const PREFIX_LEN = PREFIX.length + 6;
/** Skip the last_used_at write unless it's this stale — a write per request is real cost. */
const LAST_USED_STALE_MS = 5 * 60_000;
/** Platform-wide 24h ceiling across ALL API keys, protecting our upstream
 *  provider balance from every API customer combined. Env var, not a table:
 *  it's an operator kill switch, not per-tenant config. */
const GLOBAL_DAILY_CAP = Number(process.env.API_DAILY_CREDIT_CAP) || 50_000;

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * The API key a credit_ledger row is attributable to: its own `meta.apiKeyId`
 * for a charge, or — for a refund, which carries no apiKeyId of its own — the
 * charge it reverses, via related_ledger_id.
 *
 * Exported because GET /api/v1/me must meter with the SAME expression the cap
 * enforces with, or `daily_cap_remaining` lies about when the 429 lands.
 *
 * Summing signed credits over `kind IN ('charge','refund')` with this filter
 * nets refunds out: we promise failed generations are refunded, so a developer
 * whose jobs failed must not burn their daily cap on them.
 *
 * COALESCE short-circuits, so the subquery only runs for rows without their own
 * apiKeyId, and then it is a primary-key lookup.
 */
export const apiKeyOfLedgerRow = sql<string | null>`COALESCE(
  ${creditLedger.meta}->>'apiKeyId',
  (SELECT c.meta->>'apiKeyId' FROM credit_ledger c WHERE c.id = ${creditLedger.relatedLedgerId})
)`;

/** Returns the one-time plaintext key plus what gets persisted. */
export function generateApiKey(): { full: string; prefix: string; keyHash: string } {
  const full = PREFIX + crypto.randomBytes(32).toString('base64url');
  return { full, prefix: full.slice(0, PREFIX_LEN), keyHash: hashApiKey(full) };
}

export function hashApiKey(full: string): string {
  return crypto.createHash('sha256').update(full).digest('hex');
}

/**
 * `{ error, message, ...extra }` — the one envelope every v1 response uses (see
 * apiError in app/api/v1/shared.ts and docs/api.md §8).
 *
 * `message` is positional and required on purpose. This used to emit
 * `{ error, hint }` with no `message`, so a client printing `message` — which
 * the docs tell it to have — showed `undefined` on precisely the errors a human
 * has to read: unauthorized, both daily caps, and internal. `hint` was that
 * message under another name, so it collapsed into `message` rather than being
 * duplicated.
 */
function err(
  error: string,
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({ error, message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** `Bearer sfy_live_…` → the plaintext key, or null for anything else. */
function bearerKey(req: Request): string | null {
  const header = req.headers.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value?.startsWith(PREFIX)) return null;
  return value;
}

/**
 * Authenticates a public /api/v1 request by Bearer API key, guarantees the
 * profiles row exists, and enforces the daily spend caps on spending methods.
 * 401 invalid/revoked key · 429 daily cap exceeded · 402 InsufficientCreditsError.
 *
 * Deliberately does NOT route through `withUser`: no Clerk `auth()` hop (there
 * is no session), and no `originAllowed()` check (that is browser-CSRF logic —
 * an external server sends no Origin, so it would be meaningless here).
 */
export async function withApiKey(
  req: Request,
  handler: (auth: ApiKeyAuth) => Promise<Response> | Response,
): Promise<Response> {
  try {
    const plaintext = bearerKey(req);
    if (!plaintext) {
      return err('unauthorized', 401, 'Send "Authorization: Bearer sfy_live_…".');
    }

    // One indexed lookup on the unique key_hash. No timingSafeEqual: we're
    // comparing a hash we computed, not the secret itself.
    const [key] = await db()
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        dailyCreditCap: apiKeys.dailyCreditCap,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hashApiKey(plaintext)), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!key) return err('unauthorized', 401, 'Unknown or revoked API key.');

    // MANDATORY: charge() locks the profile row with FOR UPDATE, and FOR UPDATE
    // matching zero rows takes no lock — a missing profile silently reopens the
    // double-spend race. Same invariant withUser gets from ensureProfile.
    await ensureProfile(key.userId);

    // Spend caps gate spending, so they gate the POSTs. A GET never charges:
    // capping it locked the caller out of GET /api/v1/me — the endpoint the docs
    // send them to in order to understand the 429 — and out of polling jobs they
    // had already paid for. Skipping the scan also saves the aggregate query on
    // the only requests that are polled in a loop.
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    // Caps live in Postgres, not memory: lib/rate-limit.ts is a per-instance
    // Map, so N concurrent lambdas allow N× the limit — useless when the thing
    // being limited spends real money. Both windows come back in one scan of
    // the last day's API charges.
    const [spend] = isRead ? [null] : await db()
      .select({
        key: sql<number>`COALESCE(-SUM(${creditLedger.credits}) FILTER (WHERE ${apiKeyOfLedgerRow} = ${key.id}), 0)::int`,
        all: sql<number>`COALESCE(-SUM(${creditLedger.credits}), 0)::int`,
      })
      .from(creditLedger)
      .where(
        and(
          inArray(creditLedger.kind, ['charge', 'refund']),
          sql`${creditLedger.createdAt} > now() - interval '1 day'`,
          sql`${apiKeyOfLedgerRow} IS NOT NULL`,
        ),
      );
    const keySpent = Number(spend?.key ?? 0);
    const apiSpent = Number(spend?.all ?? 0);

    if (!isRead && keySpent >= key.dailyCreditCap) {
      // The cap is checked BEFORE the charge, not against it, so the request
      // that crosses the line is allowed through in full and one job can
      // overshoot the cap by its own price. Documented in docs/api.md §1;
      // enforcing it per-charge would need the price here, which lives in the
      // routes. ponytail: pre-charge check, tighten if overshoot ever matters
      // more than keeping pricing out of the auth layer.
      return err(
        'daily_cap_exceeded',
        429,
        `This API key has spent ${keySpent} of its ${key.dailyCreditCap} credit daily cap. Raise the cap at ${process.env.NEXT_PUBLIC_APP_URL || 'https://sociafy.app'}/developers, or wait for the rolling 24h window to roll off.`,
        { spent: keySpent, cap: key.dailyCreditCap },
      );
    }
    if (!isRead && apiSpent >= GLOBAL_DAILY_CAP) {
      return err(
        'api_capacity_exceeded',
        429,
        'The API is temporarily at its platform-wide daily limit. Try again later.',
      );
    }

    // Best-effort, unawaited, and only when already stale.
    const stale = !key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_STALE_MS;
    if (stale) {
      void db()
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, key.id))
        .catch(() => {});
    }

    return await handler({ userId: key.userId, apiKeyId: key.id });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof InsufficientCreditsError) {
      // A late InsufficientCreditsError means the atomic FOR-UPDATE charge
      // refused — same 402 shape a pre-flight would have produced.
      return insufficientCreditsResponse({ balance: e.balance, needed: e.needed });
    }
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && e.cause
      ? (e.cause instanceof Error ? e.cause.message : String(e.cause))
      : null;
    console.error('[api-key]', msg, cause ? `| cause: ${cause}` : '');
    // Never leak raw messages in production — they expose schema and stack.
    return err(
      'internal',
      500,
      'Something failed on our side and has been logged. Check GET /api/v1/me if you are unsure whether credits were charged.',
      IS_PROD ? undefined : { detail: msg },
    );
  }
}
