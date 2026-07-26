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
import { and, eq, isNull, sql } from 'drizzle-orm';
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

/** Returns the one-time plaintext key plus what gets persisted. */
export function generateApiKey(): { full: string; prefix: string; keyHash: string } {
  const full = PREFIX + crypto.randomBytes(32).toString('base64url');
  return { full, prefix: full.slice(0, PREFIX_LEN), keyHash: hashApiKey(full) };
}

export function hashApiKey(full: string): string {
  return crypto.createHash('sha256').update(full).digest('hex');
}

function err(error: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
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
 * profiles row exists, and enforces the per-key daily spend cap.
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
      return err('unauthorized', 401, { hint: 'Send "Authorization: Bearer sfy_live_…".' });
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
    if (!key) return err('unauthorized', 401, { hint: 'Unknown or revoked API key.' });

    // MANDATORY: charge() locks the profile row with FOR UPDATE, and FOR UPDATE
    // matching zero rows takes no lock — a missing profile silently reopens the
    // double-spend race. Same invariant withUser gets from ensureProfile.
    await ensureProfile(key.userId);

    // Caps live in Postgres, not memory: lib/rate-limit.ts is a per-instance
    // Map, so N concurrent lambdas allow N× the limit — useless when the thing
    // being limited spends real money. Both windows come back in one scan of
    // the last day's API charges.
    const [spend] = await db()
      .select({
        key: sql<number>`COALESCE(-SUM(${creditLedger.credits}) FILTER (WHERE ${creditLedger.meta}->>'apiKeyId' = ${key.id}), 0)::int`,
        all: sql<number>`COALESCE(-SUM(${creditLedger.credits}), 0)::int`,
      })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.kind, 'charge'),
          sql`${creditLedger.createdAt} > now() - interval '1 day'`,
          sql`${creditLedger.meta}->>'apiKeyId' IS NOT NULL`,
        ),
      );
    const keySpent = Number(spend?.key ?? 0);
    const apiSpent = Number(spend?.all ?? 0);

    if (keySpent >= key.dailyCreditCap) {
      return err('daily_cap_exceeded', 429, {
        spent: keySpent,
        cap: key.dailyCreditCap,
        hint: `This API key has spent ${keySpent} of its ${key.dailyCreditCap} credit daily cap. Raise the cap in your dashboard or wait for the 24h window to roll off.`,
      });
    }
    if (apiSpent >= GLOBAL_DAILY_CAP) {
      return err('api_capacity_exceeded', 429, {
        hint: 'The API is temporarily at its platform-wide daily limit. Try again later.',
      });
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
    return err('internal', 500, IS_PROD ? undefined : { detail: msg });
  }
}
