import crypto from 'crypto';

const SECRET = process.env.INTERNAL_API_SECRET || 'dev-secret-change-me';

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
  if (sig !== expected) return null;
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
