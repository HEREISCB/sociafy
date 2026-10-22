'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useToast } from './ui';

const TOAST_MS = 5_000; // ToastProvider's visible time

/**
 * Undo for deletes the server can't reverse (voice twin, knowledge doc,
 * mention dismiss): the caller hides the thing locally, the shared toast
 * offers Undo, and `run` (the real request) fires once the toast's time is
 * up, when another deferred delete starts, when the page unmounts (route
 * change) or on pagehide. Use keepaliveFetch in `run` so the last case lands.
 * Not in ui.tsx because useToast has no "on expire" hook; local by design.
 */
export function useDeferred() {
  const toast = useToast();
  const pending = useRef<{ run: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const flush = useCallback(() => {
    const p = pending.current;
    pending.current = null;
    if (p) { clearTimeout(p.timer); p.run(); }
  }, []);

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [flush]);

  return useCallback((msg: string, run: () => void, restore: () => void) => {
    flush();
    pending.current = { run, timer: setTimeout(flush, TOAST_MS) };
    toast(msg, {
      undo: () => {
        if (pending.current) clearTimeout(pending.current.timer);
        pending.current = null;
        restore();
      },
    });
  }, [flush, toast]);
}

/** DELETE/POST that survives the tab closing. Resolves to the Response. */
export function keepaliveFetch(url: string, method: 'DELETE' | 'POST', body?: unknown) {
  return fetch(url, {
    method,
    credentials: 'include',
    keepalive: true,
    ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}
