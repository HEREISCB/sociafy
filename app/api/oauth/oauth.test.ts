import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signState, OAUTH_COOKIE } from '../../../lib/oauth/state';

const state = {
  user: { id: 'u1' } as { id: string } | null,
  upserts: [] as { values: Record<string, unknown>; conflict: { set: Record<string, unknown> } }[],
  configured: true,
  exchangeCode: vi.fn<(a: { codeVerifier?: string }) => Promise<unknown>>(async () => ({
    tokens: { accessToken: 'real' },
    profile: { platformUserId: 'p1', handle: 'me' },
  })),
};

vi.mock('../../../lib/api', () => ({ authedUser: async () => state.user }));
vi.mock('../../../lib/rate-limit', () => ({
  rateLimit: () => ({ ok: false, retryAfterSec: 30 }),
  requestIp: () => '1.2.3.4',
}));
vi.mock('../../../lib/crypto/tokens', () => ({ encryptToken: (t: string) => `enc:${t}` }));
vi.mock('../../../lib/platforms/registry', () => ({
  getAdapter: () => ({ isConfigured: () => state.configured, exchangeCode: state.exchangeCode }),
}));
vi.mock('../../../lib/db', () => ({
  db: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) =>
        Object.assign(Promise.resolve(), {
          onConflictDoUpdate: (conflict: { set: Record<string, unknown> }) => {
            state.upserts.push({ values, conflict });
            return Promise.resolve();
          },
        }),
    }),
  }),
}));

const { GET: callback } = await import('./[platform]/callback/route');
const { GET: start } = await import('./[platform]/start/route');

function cb(platform: string, query: Record<string, string>, cookie?: string) {
  const url = new URL(`https://app.test/api/oauth/${platform}/callback`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers = cookie ? { cookie: `${OAUTH_COOKIE}=${cookie}` } : undefined;
  return callback(new NextRequest(url, { headers }), { params: Promise.resolve({ platform }) });
}

const loc = (res: Response) => new URL(res.headers.get('location')!);

describe('oauth callback', () => {
  beforeEach(() => {
    state.user = { id: 'u1' };
    state.upserts = [];
    state.configured = true;
    state.exchangeCode.mockClear();
  });

  const good = (extra: Record<string, string> = {}) =>
    ({ state: signState({ uid: 'u1', platform: 'x', next: '/onboarding', n: 'nonce1' }), ...extra });

  it('rejects a state minted for another user (account hijack)', async () => {
    state.user = { id: 'victim' };
    const res = await cb('x', good({ code: 'c' }), 'nonce1.ver');
    expect(loc(res).pathname + loc(res).search).toBe('/dashboard?tab=connections&oauth_error=oauth_state');
    expect(state.upserts).toHaveLength(0);
  });

  it('rejects when the browser cookie is missing or mismatched', async () => {
    for (const cookie of [undefined, 'other.ver']) {
      const res = await cb('x', good({ code: 'c' }), cookie);
      expect(loc(res).searchParams.get('oauth_error')).toBe('oauth_state');
    }
    expect(state.upserts).toHaveLength(0);
  });

  it('maps provider cancel to access_denied and never stubs', async () => {
    const res = await cb('x', good({ error: 'access_denied' }), 'nonce1.ver');
    expect(loc(res).pathname).toBe('/onboarding');
    expect(loc(res).searchParams.get('oauth_error')).toBe('access_denied');
    const li = await cb('x', good({ error: 'user_cancelled_login' }), 'nonce1.ver');
    expect(loc(li).searchParams.get('oauth_error')).toBe('access_denied');
    const other = await cb('x', good({ error: 'Server_Error<script>' }), 'nonce1.ver');
    expect(loc(other).searchParams.get('oauth_error')).toBe('server_errorscript');
    expect(state.upserts).toHaveLength(0);
  });

  it('exchanges with the cookie verifier, upserts, and clears the cookie', async () => {
    const res = await cb('x', good({ code: 'c' }), 'nonce1.ver');
    expect(state.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ codeVerifier: 'ver' }));
    expect(loc(res).searchParams.get('connected')).toBe('x');
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${OAUTH_COOKIE}=;.*Path=/api/oauth`));
    expect(state.upserts[0].values).toMatchObject({ userId: 'u1', platform: 'x', isStub: false });
    expect(state.upserts[0].conflict.set).toMatchObject({ lastRefreshError: null, isStub: false });
  });

  it('dev: a missing code mints a stub flagged isStub with the plain stub token', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      await cb('x', good(), 'nonce1.ver');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(state.exchangeCode).not.toHaveBeenCalled();
    expect(state.upserts[0].values).toMatchObject({ isStub: true, accessToken: 'enc:stub' });
  });
});

describe('oauth start', () => {
  it('redirects rate-limited users back with oauth_error=rate_limited', async () => {
    state.user = { id: 'u1' };
    const req = new NextRequest('https://app.test/api/oauth/x/start?next=/dashboard?tab=connections');
    const res = await start(req, { params: Promise.resolve({ platform: 'x' }) });
    expect(res.status).toBe(307);
    expect(loc(res).pathname).toBe('/dashboard');
    expect(loc(res).searchParams.get('oauth_error')).toBe('rate_limited');
  });
});
