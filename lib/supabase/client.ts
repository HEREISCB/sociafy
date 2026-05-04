'use client';

import { createBrowserClient } from '@supabase/ssr';
import { useMemo } from 'react';

export function getSupabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createBrowserClient(url, anon);
}

export function useSupabase() {
  return useMemo(() => getSupabaseBrowser(), []);
}
