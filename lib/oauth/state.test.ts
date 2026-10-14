import { describe, it, expect } from 'vitest';
import { signState, verifyState, checkOAuthCookie, makeNonce } from './state';

describe('oauth state', () => {
  it('round-trips and carries no PKCE verifier', () => {
    const n = makeNonce();
    const v = verifyState(signState({ uid: 'u1', platform: 'x', next: '/x', n }));
    expect(v).toMatchObject({ uid: 'u1', platform: 'x', n });
    expect(v).not.toHaveProperty('cv');
  });

  it('rejects tampered state', () => {
    const [json, sig] = signState({ uid: 'u1', platform: 'x', n: 'a' }).split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'u2', platform: 'x', n: 'a', ts: Date.now() })).toString('base64url');
    expect(verifyState(`${forged}.${sig}`)).toBeNull();
    expect(verifyState(json)).toBeNull();
  });

  it('checkOAuthCookie matches nonce and extracts the verifier', () => {
    expect(checkOAuthCookie('abc.verifier', 'abc')).toEqual({ cv: 'verifier' });
    expect(checkOAuthCookie('abc', 'abc')).toEqual({ cv: '' });
    expect(checkOAuthCookie('abd', 'abc')).toBeNull();
    expect(checkOAuthCookie(undefined, 'abc')).toBeNull();
    expect(checkOAuthCookie('abc', undefined)).toBeNull();
    expect(checkOAuthCookie('é', 'ab')).toBeNull();
  });
});
