import crypto from 'crypto';

const IS_PROD = process.env.NODE_ENV === 'production';
const RAW_SECRET = process.env.INTERNAL_API_SECRET;

if (IS_PROD && (!RAW_SECRET || RAW_SECRET.length < 32)) {
  // Hard-fail at module load — better than silently signing with the dev fallback.
  throw new Error(
    'INTERNAL_API_SECRET must be set to a 32+ char random string in production.',
  );
}

const SECRET = RAW_SECRET || 'dev-secret-change-me-only-for-local-development';

export type StatePayload = {
  uid: string;
  platform: string;
  next?: string;
  cv?: string; // PKCE code verifier (X)
  ts: number;
};

export function signState(payload: Omit<StatePayload, 'ts'>): string {
  const full: StatePayload = { ...payload, ts: Date.now() };
  const json = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(json).digest('base64url');
  return `${json}.${sig}`;
}

export function verifyState(state: string): StatePayload | null {
  const [json, sig] = state.split('.');
  if (!json || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(json).digest('base64url');
  // Constant-time comparison so an attacker can't time-side-channel the signature.
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(json, 'base64url').toString('utf8')) as StatePayload;
    if (Date.now() - payload.ts > 15 * 60 * 1000) return null; // 15 min expiry
    return payload;
  } catch {
    return null;
  }
}

export function makeCodeVerifier(): string {
  return crypto.randomBytes(48).toString('base64url').slice(0, 64);
}
