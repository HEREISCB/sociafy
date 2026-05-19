import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production';

// Production-only security headers. Skipped in dev so HMR / inline scripts
// don't get blocked. CSP is intentionally permissive on script-src because
// Next.js + Clerk both inject inline scripts that would otherwise break.
// Tighten over time by switching to nonces.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://api.anthropic.com",
      "frame-src 'self' https://challenges.cloudflare.com https://*.clerk.com",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  // Next.js 16 blocks dev resources (HMR, fonts, chunks) when the origin isn't
  // localhost. Tunnels and ngrok URLs need to be allowlisted explicitly.
  allowedDevOrigins: [
    'winqc.velinaai.in',
    '*.velinaai.in',
    '*.trycloudflare.com',
    '*.ngrok-free.app',
    '*.ngrok.io',
  ],

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
