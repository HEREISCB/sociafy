import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '../env';

export async function getSupabaseServer() {
  const cookieStore = await cookies();
  if (!env.supabase.url || !env.supabase.anonKey) {
    return null;
  }
  return createServerClient(env.supabase.url, env.supabase.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component — ignore. Proxy/Route Handlers refresh sessions.
        }
      },
    },
  });
}

export async function getSessionUser() {
  const supabase = await getSupabaseServer();
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

export async function requireUser() {
  const user = await getSessionUser();
  if (!user) throw new Response('Unauthorized', { status: 401 });
  return user;
}
