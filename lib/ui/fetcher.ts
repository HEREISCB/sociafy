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

export async function apiPost<T = unknown>(
  url: string,
  body: unknown,
  opts?: { timeoutMs?: number },
): Promise<T> {
  // Default 2-minute ceiling. Long enough for tool-using model calls, short
  // enough that a wedged server doesn't leave the UI stuck on "Generating…"
  // forever. Callers can override per request.
  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
      signal: controller.signal,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`${r.status}: ${detail}`);
    }
    return r.json();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('timeout: request took too long, try again or disable research');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** apiPost/apiPatch throw `Error("<status>: <json-body>")`. Pull out the
 *  structured hint when there is one so the UI shows actionable copy ("top up
 *  your credits", "X is not connected") instead of a raw status dump. */
export function friendlyApiError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/^(\d{3}):\s*(\{[\s\S]*\})?/);
  if (m) {
    const status = Number(m[1]);
    let body: { error?: string; hint?: string; balance?: number; needed?: number } = {};
    try { body = m[2] ? JSON.parse(m[2]) : {}; } catch { /* non-JSON body */ }
    if (status === 402 && body.error === 'insufficient_credits') {
      return `You need ${body.needed ?? 'more'} credits but have ${body.balance ?? 0}. Top up on the Billing page, then try again.`;
    }
    if (body.hint) return body.hint;
    if (status === 401) return 'Your session expired — sign in again.';
    if (status === 429) return 'Too many requests — wait a minute and try again.';
    if (status >= 500) return 'Something went wrong on the server. Try again shortly.';
  }
  if (msg.startsWith('timeout')) return 'The request took too long — try again.';
  return `Failed: ${msg.slice(0, 120)}`;
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
