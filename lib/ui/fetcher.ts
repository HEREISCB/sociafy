'use client';

import useSWR, { type SWRConfiguration } from 'swr';

export const fetcher = async (url: string) => {
  const r = await fetch(url, { credentials: 'include' });
  if (r.status === 401) return { __unauth: true };
  if (r.status === 503) return { __stub: true };
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export function useApi<T>(url: string | null, config?: SWRConfiguration) {
  const { data, error, mutate, isLoading } = useSWR<T | { __unauth?: boolean; __stub?: boolean }>(url, fetcher, {
    revalidateOnFocus: false,
    ...config,
  });
  const unauth = data && typeof data === 'object' && '__unauth' in data;
  const stub = data && typeof data === 'object' && '__stub' in data;
  return {
    data: unauth || stub ? null : (data as T | undefined),
    error,
    mutate,
    isLoading,
    unauth,
    stub,
  };
}

export async function apiPost<T = unknown>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`${r.status}: ${detail}`);
  }
  return r.json();
}

export async function apiPatch<T = unknown>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`${r.status}: ${detail}`);
  }
  return r.json();
}

export async function apiDelete<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url, { method: 'DELETE', credentials: 'include' });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
