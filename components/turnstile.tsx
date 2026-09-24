'use client';

import { useEffect, useRef } from 'react';
import Script from 'next/script';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; 'expired-callback'?: () => void; appearance?: string }) => string;
      reset: (id?: string) => void;
    };
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

/**
 * Cloudflare Turnstile. Renders nothing when the site key isn't set. Usually
 * invisible ("interaction-only"): a checkbox only appears when Cloudflare is unsure.
 * Tokens are single-use, so call the returned reset after each submit.
 */
export function Turnstile({ onToken, resetKey }: { onToken: (t: string | null) => void; resetKey?: unknown }) {
  const el = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  const cb = useRef(onToken);
  useEffect(() => { cb.current = onToken; });

  const mount = () => {
    if (!SITE_KEY || !el.current || !window.turnstile || id.current) return;
    id.current = window.turnstile.render(el.current, {
      sitekey: SITE_KEY,
      appearance: 'interaction-only',
      callback: (t) => cb.current(t),
      'expired-callback': () => cb.current(null),
    });
  };

  useEffect(mount, []);
  useEffect(() => {
    if (id.current && window.turnstile) {
      cb.current(null);
      window.turnstile.reset(id.current);
    }
  }, [resetKey]);

  if (!SITE_KEY) return null;
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive" onLoad={mount} />
      <div ref={el} style={{ marginTop: 10 }} />
    </>
  );
}

export const turnstileRequired = !!SITE_KEY;
