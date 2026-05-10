import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { isStubMode } from './env';
import { db } from './db';
import { profiles } from './db/schema';
import { eq } from 'drizzle-orm';

export type ApiUser = { id: string; email?: string | null };

export async function authedUser(): Promise<ApiUser | null> {
  if (isStubMode.clerk()) return null;
  const { userId } = await auth();
  if (!userId) return null;
  return { id: userId, email: null };
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

export async function withUser<T>(
  handler: (user: ApiUser) => Promise<T> | T,
): Promise<NextResponse> {
  if (isStubMode.clerk()) {
    return jsonError('clerk_not_configured', 503);
  }
  const user = await authedUser();
  if (!user) return jsonError('unauthorized', 401);
  try {
    await ensureProfile(user.id);
    const result = await handler(user);
    if (result instanceof NextResponse) return result;
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Response) return e as NextResponse;
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[api]', msg);
    return jsonError('internal', 500, { detail: msg });
  }
}

export function checkCronAuth(request: Request): boolean {
  const auth = request.headers.get('authorization') || '';
  const expected = `Bearer ${process.env.CRON_SECRET || 'dev-cron-secret-change-me'}`;
  return auth === expected;
}
