import { NextResponse } from 'next/server';
import { getSessionUser } from './supabase/server';
import { isStubMode } from './env';

export type ApiUser = { id: string; email?: string | null };

export async function authedUser(): Promise<ApiUser | null> {
  const user = await getSessionUser();
  if (!user) return null;
  return { id: user.id, email: user.email ?? null };
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export async function withUser<T>(
  handler: (user: ApiUser) => Promise<T> | T,
): Promise<NextResponse> {
  if (isStubMode.supabase()) {
    return jsonError('supabase_not_configured', 503);
  }
  const user = await authedUser();
  if (!user) return jsonError('unauthorized', 401);
  try {
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
