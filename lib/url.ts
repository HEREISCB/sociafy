import type { NextRequest } from 'next/server';

/**
 * Resolve the canonical origin for the current request.
 *
 * In dev with a tunnel (Cloudflare Tunnel, ngrok, etc.) the underlying Next.js
 * server still sees the request as if it came to localhost. The tunnel forwards
 * the real host via X-Forwarded-Host. Honor that so OAuth redirect_uri values
 * and back-to-app redirects use the public URL the user is actually on.
 */
const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * In prod, only honor X-Forwarded-Host if it matches an allowed host. This
 * prevents host-header poisoning from misconfigured proxies redirecting
 * OAuth flows or webhook URLs to attacker-controlled hostnames.
 */
function isAllowedForwardedHost(host: string): boolean {
  if (!IS_PROD) return true;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (!appUrl) return false;
  try {
    if (host === new URL(appUrl).host) return true;
  } catch {
    return false;
  }
  const extras = (process.env.TRUSTED_FORWARDED_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return extras.includes(host);
}

export function getOrigin(req: NextRequest): string {
  const forwardedHost = req.headers.get('x-forwarded-host');
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (forwardedHost && isAllowedForwardedHost(forwardedHost)) {
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
