import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mutable mock state. Kept in one object (never reassigned) so the hoisted
// vi.mock factories can close over it safely — same pattern as
// lib/credits/grantIdempotent.test.ts.
const state = {
  /** The api_keys row the indexed lookup finds, or null for "no such key". */
  keyRow: null as null | { id: string; userId: string; dailyCreditCap: number; lastUsedAt: Date | null },
  /** What the 24h spend aggregate returns. */
  spend: { key: 0, all: 0 },
  selectCalls: 0,
  updates: [] as Record<string, unknown>[],
  profilesEnsured: [] as string[],
};

vi.mock('./db', () => ({
  db: () => ({
    // The key lookup ends in .limit(1); the spend aggregate is awaited directly.
    select: () => ({
      from: () => ({
        where: () => {
          state.selectCalls++;
          return Object.assign(Promise.resolve([state.spend]), {
            limit: () => Promise.resolve(state.keyRow ? [state.keyRow] : []),
          });
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(v);
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

// Mocked so the test doesn't drag in Clerk/next-server, and so we can assert
// the profile-row guarantee actually happens.
vi.mock('./api', () => ({
  ensureProfile: (userId: string) => {
    state.profilesEnsured.push(userId);
    return Promise.resolve();
  },
}));

import { generateApiKey, hashApiKey, withApiKey } from './api-key';

const req = (auth?: string) =>
  new Request('https://sociafy.app/api/v1/images', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  state.keyRow = { id: 'key-1', userId: 'user_abc', dailyCreditCap: 100, lastUsedAt: null };
  state.spend = { key: 0, all: 0 };
  state.selectCalls = 0;
  state.updates.length = 0;
  state.profilesEnsured.length = 0;
});

describe('generateApiKey / hashApiKey', () => {
  it('round-trips: the stored hash matches a re-hash of the plaintext', () => {
    const { full, prefix, keyHash } = generateApiKey();
    // Not `sk_live_` — that is Stripe's format and secret scanners match on it.
    expect(full.startsWith('sfy_live_')).toBe(true);
    // The stored prefix is the namespace plus 6 identifying chars. Asserted as a
    // property rather than a hardcoded length, so renaming the prefix can't
    // silently shrink how much of the key is retained for support.
    const expectedLen = 'sfy_live_'.length + 6;
    expect(prefix).toBe(full.slice(0, expectedLen));
    expect(prefix.length).toBe(expectedLen);
    expect(keyHash).toBe(hashApiKey(full));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    // The hash must not contain the secret, and the prefix must not be enough
    // to reconstruct it.
    expect(keyHash).not.toContain(full.slice(8));
  });

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().full));
    expect(keys.size).toBe(50);
  });
});

describe('withApiKey auth', () => {
  it('401s with no Authorization header', async () => {
    const handler = vi.fn();
    const res = await withApiKey(req(), handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('401s on a non-Bearer or non-sfy_live credential', async () => {
    expect((await withApiKey(req('Basic sfy_live_abc'), vi.fn())).status).toBe(401);
    expect((await withApiKey(req('Bearer pk_test_abc'), vi.fn())).status).toBe(401);
  });

  it('401s on an unknown or revoked key (the lookup filters revoked_at)', async () => {
    state.keyRow = null;
    const handler = vi.fn();
    const res = await withApiKey(req(`Bearer ${generateApiKey().full}`), handler);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    expect(handler).not.toHaveBeenCalled();
    // Nothing is charged and no profile is touched for an invalid key.
    expect(state.profilesEnsured).toEqual([]);
  });

  it('passes the userId + apiKeyId through and ensures the profile row first', async () => {
    const seen: unknown[] = [];
    const res = await withApiKey(req(`Bearer ${generateApiKey().full}`), (auth) => {
      // Must run AFTER ensureProfile: charge() takes FOR UPDATE on the profile
      // row, and FOR UPDATE on zero rows takes no lock at all.
      expect(state.profilesEnsured).toEqual(['user_abc']);
      seen.push(auth);
      return new Response('ok');
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ userId: 'user_abc', apiKeyId: 'key-1' }]);
  });

  it('touches last_used_at when stale and skips the write when fresh', async () => {
    await withApiKey(req(`Bearer ${generateApiKey().full}`), () => new Response('ok'));
    expect(state.updates).toHaveLength(1);

    state.keyRow = { id: 'key-1', userId: 'user_abc', dailyCreditCap: 100, lastUsedAt: new Date() };
    state.updates.length = 0;
    await withApiKey(req(`Bearer ${generateApiKey().full}`), () => new Response('ok'));
    expect(state.updates).toHaveLength(0);
  });
});

describe('withApiKey daily caps', () => {
  const call = (handler = vi.fn(() => new Response('ok'))) =>
    withApiKey(req(`Bearer ${generateApiKey().full}`), handler);

  it('allows the request one credit below the per-key cap', async () => {
    state.spend = { key: 99, all: 99 };
    const handler = vi.fn(() => new Response('ok'));
    expect((await call(handler)).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('429s exactly at the per-key cap', async () => {
    state.spend = { key: 100, all: 100 };
    const handler = vi.fn(() => new Response('ok'));
    const res = await call(handler);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'daily_cap_exceeded', spent: 100, cap: 100 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('429s on the platform-wide kill switch even when the key is under its own cap', async () => {
    state.keyRow = { id: 'key-1', userId: 'user_abc', dailyCreditCap: 100_000, lastUsedAt: null };
    state.spend = { key: 0, all: 50_000 }; // default API_DAILY_CREDIT_CAP
    const handler = vi.fn(() => new Response('ok'));
    const res = await call(handler);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'api_capacity_exceeded' });
    expect(handler).not.toHaveBeenCalled();
  });
});
