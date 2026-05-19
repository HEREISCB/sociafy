/**
 * Lightweight in-process token-bucket rate limiter.
 *
 * Good for a single-server deploy or a small cluster where users are mostly
 * sticky to one instance. For multi-instance prod with strict global limits,
 * swap the backing Map for Upstash Redis / Vercel KV / etc — the API stays
 * the same.
 */

type Bucket = {
  tokens: number;
  updatedAt: number;
};

type Limit = {
  capacity: number;
  refillPerSecond: number;
};

export const LIMITS = {
  publish: { capacity: 8, refillPerSecond: 8 / 60 },       // 8/min
  agentRun: { capacity: 3, refillPerSecond: 3 / 300 },     // 3 per 5 min
  oauthStart: { capacity: 20, refillPerSecond: 20 / 60 },  // 20/min
  webhook: { capacity: 120, refillPerSecond: 120 / 60 },   // 2/sec sustained per IP
  general: { capacity: 60, refillPerSecond: 60 / 60 },     // 1/sec sustained
} as const satisfies Record<string, Limit>;

type LimitKey = keyof typeof LIMITS;

const store = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

function takeBucket(key: string, limit: Limit): Bucket {
  const now = Date.now();
  let b = store.get(key);
  if (!b) {
    // Rough LRU: when we get too big, drop the oldest 10% by updatedAt.
    if (store.size >= MAX_BUCKETS) {
      const entries = Array.from(store.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      const toDrop = Math.floor(MAX_BUCKETS / 10);
      for (let i = 0; i < toDrop; i++) store.delete(entries[i][0]);
    }
    b = { tokens: limit.capacity, updatedAt: now };
    store.set(key, b);
    return b;
  }
  const elapsedSec = (now - b.updatedAt) / 1000;
  b.tokens = Math.min(limit.capacity, b.tokens + elapsedSec * limit.refillPerSecond);
  b.updatedAt = now;
  return b;
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
};

export function rateLimit(scope: LimitKey, subject: string): RateLimitResult {
  const limit = LIMITS[scope];
  const key = `${scope}:${subject}`;
  const b = takeBucket(key, limit);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
  }
  // 0 < tokens < 1 — compute time until next whole token.
  const need = 1 - b.tokens;
  const retryAfterSec = Math.ceil(need / limit.refillPerSecond);
  return { ok: false, remaining: 0, retryAfterSec };
}

/**
 * Extract a best-effort IP for unauthenticated rate-limit keys.
 * X-Forwarded-For from Vercel/Cloudflare comes pre-validated, but in dev we
 * also fall back to a placeholder. Don't combine with user IDs for auth rate
 * limits — use the user ID directly.
 */
export function requestIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = headers.get('x-real-ip');
  if (real) return real;
  return 'anon';
}
