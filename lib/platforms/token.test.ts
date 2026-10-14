/**
 * X refresh tokens are single-use. Two processes refreshing the same account
 * at once (cron + "Post now", or two cron posts in one batch) used to both
 * call the provider; the loser presented a burned token and the account died
 * until the user reconnected. ensureFreshToken now locks the row and re-reads
 * it, skipping the provider call when someone else already refreshed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encryptToken } from '../crypto/tokens';
import type { OAuthTokens } from './types';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  /** What SELECT ... FOR UPDATE sees: the row as committed by whoever held the lock. */
  locked: null as Record<string, unknown> | null,
  writes: [] as Record<string, unknown>[],
}));

vi.mock('../db', () => ({
  db: () => ({
    transaction(fn: (tx: unknown) => unknown) { return fn(this); },
    execute: () => Promise.resolve(),
    select: () => ({
      from: () => ({ where: () => ({ for: () => Promise.resolve(state.locked ? [state.locked] : []) }) }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({ where: () => { state.writes.push(v); return Promise.resolve(); } }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
  }),
}));

const refresh = vi.fn<(rt: string) => Promise<OAuthTokens>>(async () => ({
  accessToken: 'access-3',
  refreshToken: 'refresh-3',
  expiresAt: new Date(Date.now() + 2 * 3_600_000),
}));
vi.mock('./registry', () => ({ getAdapter: () => ({ refresh }) }));

import { ensureFreshToken } from './token';

type Acct = Parameters<typeof ensureFreshToken>[0];

const MIN = 60_000;
const row = (access: string, rt: string, expiresInMs: number): Row => ({
  id: 'acct-1',
  userId: 'u1',
  platform: 'x',
  handle: 'me',
  accessToken: encryptToken(access),
  refreshToken: encryptToken(rt),
  tokenExpiresAt: new Date(Date.now() + expiresInMs),
  scope: null,
  isStub: false,
  lastRefreshError: null,
  updatedAt: new Date(),
});

beforeEach(() => {
  refresh.mockClear();
  state.writes = [];
});

describe('ensureFreshToken — concurrent refresh', () => {
  it('returns the row another process already refreshed, without calling the provider', async () => {
    const stale = row('access-1', 'refresh-1', 1 * MIN);
    state.locked = row('access-2', 'refresh-2', 120 * MIN); // refreshed while we waited

    const out = await ensureFreshToken(stale as unknown as Acct);

    expect(refresh).not.toHaveBeenCalled();
    expect(out.accessToken).toBe('access-2');
    expect(out.refreshToken).toBe('refresh-2');
    expect(state.writes).toEqual([]);
  });

  it('refreshes with the locked row’s refresh token when still near expiry', async () => {
    const stale = row('access-1', 'refresh-1', 1 * MIN);
    state.locked = stale;

    const out = await ensureFreshToken(stale as unknown as Acct);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('refresh-1');
    expect(out.accessToken).toBe('access-3');
    expect(state.writes).toHaveLength(1);
  });
});
