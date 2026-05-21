import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { auth, currentUser } from '@clerk/nextjs/server';
import { isStubMode } from './env';
import { db } from './db';
import { profiles } from './db/schema';
import { eq } from 'drizzle-orm';
import { getOrigin } from './url';

export type ApiUser = { id: string; email?: string | null };

export async function authedUser(): Promise<ApiUser | null> {
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

// Ensure a profile row exists for the current Clerk user. Idempotent. Best-effort metadata sync.
async function ensureProfile(userId: string) {
  if (isStubMode.database()) return;
  const existing = await db().select({ id: profiles.id }).from(profiles).where(eq(profiles.id, userId)).limit(1);
  if (existing.length > 0) return;
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

const IS_PROD = process.env.NODE_ENV === 'production';

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
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[api]', msg);
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
