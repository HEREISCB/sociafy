import { createClient } from '@supabase/supabase-js';
import { env } from '../env';

let _admin: ReturnType<typeof createClient> | null = null;

export function getSupabaseAdmin() {
  if (_admin) return _admin;
  if (!env.supabase.url || !env.supabase.serviceRoleKey) return null;
  _admin = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}
