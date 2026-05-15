import type { NextRequest } from 'next/server';

/**
 * Resolve the canonical origin for the current request.
 *
 * In dev with a tunnel (Cloudflare Tunnel, ngrok, etc.) the underlying Next.js
 * server still sees the request as if it came to localhost. The tunnel forwards
 * the real host via X-Forwarded-Host. Honor that so OAuth redirect_uri values
 * and back-to-app redirects use the public URL the user is actually on.
 */
export function getOrigin(req: NextRequest): string {
  const forwardedHost = req.headers.get('x-forwarded-host');
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  const host = req.headers.get('host');
  if (host) {
    const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
    return `${proto}://${host}`;
  }
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  return new URL(req.url).origin;
}

export function absoluteUrl(req: NextRequest, path: string): string {
  return new URL(path, getOrigin(req)).toString();
}
