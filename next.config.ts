import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production';

// A Clerk PRODUCTION instance serves clerk-js from your own custom domain
// (e.g. https://clerk.sociafy.app/npm/...), not from *.clerk.accounts.dev.
// That host is encoded inside the publishable key, so derive it instead of
// hardcoding — keeps the CSP correct across test/live keys and domain changes.
function clerkFrontendOrigin(): string | null {
  const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '';
  const m = pk.match(/^pk_(?:test|live)_(.+)$/);
  if (!m) return null;
  try {
    const host = Buffer.from(m[1], 'base64').toString('utf8').replace(/\$+$/, '').trim();
    return host ? `https://${host}` : null;
  } catch {
    return null;
  }
}

const clerkOrigin = clerkFrontendOrigin();
// Always include the wildcards (cover dev/test FAPI + Clerk's CDN/telemetry),
// plus the resolved production custom-domain origin when present.
const clerkScript = ['https://*.clerk.accounts.dev', 'https://*.clerk.com', clerkOrigin]
  .filter(Boolean)
  .join(' ');

// Production-only security headers. Skipped in dev so HMR / inline scripts
// don't get blocked. CSP is intentionally permissive on script-src because
// Next.js + Clerk both inject inline scripts that would otherwise break.
// Tighten over time by switching to nonces.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${clerkScript} https://challenges.cloudflare.com https://static.cloudflareinsights.com https://checkout.razorpay.com`,
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      `connect-src 'self' ${clerkScript} https://api.anthropic.com https://cloudflareinsights.com https://api.razorpay.com https://lumberjack.razorpay.com https://*.razorpay.com`,
      `frame-src 'self' https://challenges.cloudflare.com https://*.clerk.com${clerkOrigin ? ` ${clerkOrigin}` : ''} https://api.razorpay.com https://*.razorpay.com`,
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

// Media lives on the R2 public bucket; let the image optimizer resize it for thumbnails
// (components/thumb-img.tsx). Only our own bucket, never all of *.r2.dev.
const r2Base = (process.env.NEXT_PUBLIC_R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');

const nextConfig: NextConfig = {
  images: {
    remotePatterns: r2Base ? [new URL(`${r2Base}/**`)] : [],
  },

  // Next.js 16 blocks dev resources (HMR, fonts, chunks) when the origin isn't
  // localhost. Tunnels and ngrok URLs need to be allowlisted explicitly.
  allowedDevOrigins: [
    'winqc.velinaai.in',
    '*.velinaai.in',
    '*.trycloudflare.com',
    '*.ngrok-free.app',
    '*.ngrok.io',
    'sociafy.app',
    '*.sociafy.app',
  ],

  // Old URLs from the /dashboard?tab= era and the pre-Settings account pages.
  // Query strings pass through to the destination (oauth_error, connected,
  // handle, platform, checkout all survive). 307s: the IA may still move.
  async redirects() {
    const tab = (value: string, destination: string) => ({
      source: '/dashboard',
      has: [{ type: 'query' as const, key: 'tab', value }],
      destination,
      permanent: false,
    });
    const moved = (source: string, destination: string) => ({ source, destination, permanent: false });
    return [
      tab('compose', '/compose'),
      tab('agent', '/autopilot'),
      tab('connections', '/settings/connections'),
      tab('shield', '/settings/mentions'),
      tab('onboarding', '/onboarding'),
      moved('/agent', '/autopilot'),
      moved('/connections', '/settings/connections'),
      moved('/billing', '/account/billing'),
      moved('/usage', '/account/billing'),
      moved('/settings/plan', '/account/billing'),
      moved('/settings/api', '/account/api'),
      // Home and Calendar merged: the week/month views live on /dashboard.
      moved('/calendar', '/dashboard'),
      // Exact match: /developers/reference stays a real page. The public
      // reference, not /account/api — that sends signed-out readers to login.
      moved('/developers', '/developers/reference'),
      moved('/studio/voice', '/settings/voice'),
    ];
  },

  async headers() {
    if (!isProd) return [];
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
