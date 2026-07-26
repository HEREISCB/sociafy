import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { auth, currentUser } from '@clerk/nextjs/server';
import { isStubMode } from './env';
import { db } from './db';
import { profiles } from './db/schema';
import { eq } from 'drizzle-orm';
import { getOrigin } from './url';
import { InsufficientCreditsError, insufficientCreditsResponse } from './credits/ledger';

export type ApiUser = { id: string; email?: string | null };

export async function authedUser(): Promise<ApiUser | null> {
  // Dev bypass: SKIP_AUTH_DEV=true in .env.local lets you hit auth'd routes
  // locally without setting up Clerk. Never set this in production.
  if (process.env.SKIP_AUTH_DEV === 'true' && process.env.NODE_ENV === 'development') {
    return { id: 'dev-user-local', email: 'dev@localhost' };
  }
  // Clerk v7 supports keyless mode when no env keys are set — it auto-mounts a temp dev instance.
  // We trust whatever Clerk's auth() returns. No stub short-circuit.
  try {
    const { userId } = await auth();
    if (!userId) return null;
    return { id: userId, email: null };
  } catch {
    return null;
  }
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/**
 * Ensure a profile row exists for the current Clerk user. Idempotent. Best-effort metadata sync.
 *
 * Exported because `withApiKey` (lib/api-key.ts) must guarantee the same
 * invariant: `charge()` serializes concurrent spends with
 * `SELECT … FOR UPDATE` on the profile row, and FOR UPDATE matching zero rows
 * takes no lock at all — a missing profile silently reopens the double-spend
 * race. Every auth path must run this before anything can charge.
 */
export async function ensureProfile(userId: string) {
  if (isStubMode.database()) return;
  const [existing] = await db()
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!existing) {
    let meta: { displayName?: string; email?: string; avatarUrl?: string } = {};
    try {
      const u = await currentUser();
      if (u) {
        meta = {
          displayName: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || null as unknown as string,
          email: u.emailAddresses?.[0]?.emailAddress ?? null as unknown as string,
          avatarUrl: u.imageUrl ?? null as unknown as string,
        };
      }
    } catch {
      // currentUser() can fail outside of authenticated request contexts — that's OK
    }
    await db().insert(profiles).values({
      id: userId,
      displayName: meta.displayName ?? null,
      email: meta.email ?? null,
      avatarUrl: meta.avatarUrl ?? null,
    }).onConflictDoNothing();
  }
  // No automatic signup credits. Users start at 0 and must purchase (or use the
  // demo grant endpoint) before any paid action will succeed.
}

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Recognize upstream AI-provider failures (OpenAI APIError shapes) that are
 * NOT the caller's fault, so routes can return an actionable 503 instead of a
 * generic 500. `insufficient_quota` means the platform's OpenAI account is out
 * of funds — every generation in the app fails until it's topped up, and the
 * user can do nothing about it from the UI.
 */
export function aiProviderHint(e: unknown): { error: string; hint: string } | null {
  if (!e || typeof e !== 'object') return null;
  const err = e as { status?: number; code?: string | null };
  if (err.code === 'insufficient_quota') {
    return {
      error: 'ai_unavailable',
      hint: 'AI generation is temporarily unavailable (provider quota exhausted). Your credits were refunded — please try again later.',
    };
  }
  if (err.code === 'invalid_api_key' || err.code === 'account_deactivated') {
    return {
      error: 'ai_unavailable',
      hint: 'AI generation is temporarily unavailable (provider configuration). Your credits were refunded — please try again later.',
    };
  }
  if (err.status === 429) {
    return {
      error: 'ai_busy',
      hint: 'The AI provider is rate-limiting requests. Wait a moment and try again.',
    };
  }
  return null;
}

/**
 * For non-GET requests verify the Origin (or Referer fallback) matches the
 * server's own origin. Clerk cookies are SameSite=Lax, which already blocks
 * top-level cross-site POSTs from forms, but a defense-in-depth check on
 * Origin is cheap and catches sub-domain / iframe edge cases.
 */
function originAllowed(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const expected = getOrigin(request as unknown as Parameters<typeof getOrigin>[0]);
  const expectedHost = safeHost(expected);
  if (!expectedHost) return true; // can't determine, don't block (dev edge cases)
  const origin = request.headers.get('origin');
  if (origin) {
    return safeHost(origin) === expectedHost;
  }
  // No Origin: check Referer (older browsers). If neither is present, allow —
  // this is most commonly a same-origin fetch from our own client code.
  const referer = request.headers.get('referer');
  if (referer) {
    return safeHost(referer) === expectedHost;
  }
  return true;
}

function safeHost(input: string): string | null {
  try {
    return new URL(input).host;
  } catch {
    return null;
  }
}

export async function withUser<T>(
  handler: (user: ApiUser) => Promise<T> | T,
  request?: Request,
): Promise<NextResponse> {
  if (request && !originAllowed(request)) {
    return jsonError('forbidden_origin', 403);
  }
  const user = await authedUser();
  if (!user) return jsonError('unauthorized', 401);
  try {
    await ensureProfile(user.id);
    const result = await handler(user);
    // Pass through any Response (incl. plain Response used by rate-limit
    // branches). Previously this checked `instanceof NextResponse`, which
    // missed plain Response objects — they'd fall through to
    // NextResponse.json(result), which silently serializes the Response as
    // `{}` and returns 200, breaking every callsite that expected a real
    // payload back. NextResponse extends Response so this still passes
    // NextResponse-typed returns through unchanged.
    if (result instanceof Response) return result as unknown as NextResponse;
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Response) return e as NextResponse;
    if (e instanceof InsufficientCreditsError) {
      // A late InsufficientCreditsError means the atomic FOR-UPDATE charge
      // refused — the caller either skipped the pre-flight or their balance
      // dropped between pre-flight and charge (parallel request). Return the
      // same 402 shape the pre-flight would have produced.
      return insufficientCreditsResponse({ balance: e.balance, needed: e.needed }) as NextResponse;
    }
    const ai = aiProviderHint(e);
    if (ai) {
      console.error('[api] ai provider failure:', e instanceof Error ? e.message : String(e));
      return jsonError(ai.error, 503, { hint: ai.hint });
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Drizzle wraps DB failures as "Failed query: ..." and stashes the real
    // Postgres reason (e.g. `column "x" does not exist`) on `.cause`. Log it so
    // schema drift / connection faults are diagnosable straight from the logs.
    const cause = e instanceof Error && e.cause
      ? (e.cause instanceof Error ? e.cause.message : String(e.cause))
      : null;
    console.error('[api]', msg, cause ? `| cause: ${cause}` : '');
    // Never expose raw error messages in production — they leak schema and stack.
    return jsonError('internal', 500, IS_PROD ? undefined : { detail: msg });
  }
}

/**
 * Verify cron Bearer token. Refuses to run if CRON_SECRET is unset — closes a
 * footgun where a misconfigured prod env would silently accept the dev fallback.
 */
export function checkCronAuth(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const authHeader = request.headers.get('authorization') || '';
  const expected = `Bearer ${secret}`;
  try {
    return authHeader.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}
