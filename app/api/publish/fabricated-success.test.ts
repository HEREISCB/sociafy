import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { PublishResult } from '../../../lib/platforms/types';

/**
 * A stub publish is not a success.
 *
 * Every platform adapter short-circuits to stubPublish() when it isn't
 * configured (or the stored token is 'stub'): nothing is posted and the
 * returned url is a dead stub.sociafy.local link. These tests pin that the
 * "post now" route and the shield approve route refuse to record that as
 * published — plus the shield retry guard and the dev-only stub-account gate.
 */

type Select = Record<string, unknown>[];

const state = {
  selects: [] as Select[],
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
};

// Promise that also answers .limit()/.returning() so both drizzle chain
// shapes the routes use (awaited directly, or awaited after .limit()) work.
const thenable = <T>(value: T, extra: Record<string, unknown> = {}) =>
  Object.assign(Promise.resolve(value), extra);

vi.mock('../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: () => {
        const rows = state.selects.shift() ?? [];
        return { where: () => thenable(rows, { limit: () => Promise.resolve(rows) }) };
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        state.updates.push(set);
        return { where: () => Promise.resolve([]) };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.inserts.push(values);
        const row = [{ ...values, id: 'sp-1' }];
        return thenable(row, { returning: () => Promise.resolve(row) });
      },
    }),
  }),
}));

vi.mock('../../../lib/api', () => ({
  authedUser: async () => ({ id: 'u1' }),
  jsonError: (message: string, status = 400, extra?: Record<string, unknown>) =>
    NextResponse.json({ error: message, ...extra }, { status }),
  withUser: async (handler: (u: { id: string }) => unknown) => {
    const result = await handler({ id: 'u1' });
    return result instanceof Response ? result : NextResponse.json(result);
  },
}));

let publishOut: PublishResult = { platformPostId: 'real-1', url: 'https://x.com/p/1' };
const publishText = vi.fn(async () => publishOut);
vi.mock('../../../lib/platforms/registry', () => ({
  getAdapter: () => ({ publishText }),
}));

let freshToken: Record<string, unknown> = {};
vi.mock('../../../lib/platforms/token', () => ({
  ensureFreshToken: async (a: Record<string, unknown>) => ({ ...a, ...freshToken }),
}));

import { POST as publishPOST } from './route';
import { POST as approvePOST } from '../shield/actions/[id]/approve/route';
import { POST as accountsPOST } from '../accounts/route';

const STUB_OUT: PublishResult = {
  platformPostId: 'stub-x-1',
  url: 'https://stub.sociafy.local/x/stub-x-1',
  stub: true,
};

const DRAFT = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u1',
  body: 'hello',
  targetPlatforms: ['x'],
  perPlatformText: null,
  media: [],
};

const ACCOUNT = {
  id: 'a1',
  userId: 'u1',
  platform: 'x',
  accessToken: 'stub',
  refreshToken: null,
  platformUserId: 'p1',
  meta: null,
  isStub: true,
  tokenExpiresAt: null,
  lastRefreshError: null,
};

const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const statuses = () => state.updates.map((u) => u.status);

beforeEach(() => {
  state.selects = [];
  state.updates = [];
  state.inserts = [];
  publishOut = { platformPostId: 'real-1', url: 'https://x.com/p/1' };
  freshToken = {};
  publishText.mockClear();
});

describe('POST /api/publish', () => {
  it('fails instead of reporting a stub publish as published', async () => {
    publishOut = STUB_OUT;
    state.selects = [[DRAFT], [ACCOUNT]];

    const res = await publishPOST(req({ draftId: DRAFT.id, platforms: ['x'] }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(String(body.error)).toContain('platform_not_connected');
    expect(body.results[0].ok).toBe(false);
    expect(statuses()).toContain('failed');
    expect(statuses()).not.toContain('published');
    // No dead stub.sociafy.local link handed to the client.
    expect(JSON.stringify(body)).not.toContain('stub.sociafy.local');
  });

  it('still records a real publish as published with a 200', async () => {
    state.selects = [[DRAFT], [{ ...ACCOUNT, accessToken: 'real', isStub: false }]];

    const res = await publishPOST(req({ draftId: DRAFT.id, platforms: ['x'] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0]).toMatchObject({ ok: true, url: 'https://x.com/p/1' });
    expect(statuses()).toContain('published');
  });
});

describe('POST /api/shield/actions/[id]/approve', () => {
  const action = { id: 's1', userId: 'u1', status: 'pending', script: 'sorry', targetPlatform: 'x', targetPostId: null };

  it('fails instead of reporting a stub reply as published', async () => {
    publishOut = STUB_OUT;
    state.selects = [[action], [ACCOUNT]];

    const res = await approvePOST(req({}), ctx('s1'));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe('platform_not_connected');
    expect(String(body.hint)).toContain('nothing was posted');
    expect(statuses()).toContain('failed');
    expect(statuses()).not.toContain('published');
  });

  it('retries a previously failed action instead of 409', async () => {
    state.selects = [[{ ...action, status: 'failed', error: 'boom' }], [ACCOUNT]];

    const res = await approvePOST(req({}), ctx('s1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'published' });
    expect(publishText).toHaveBeenCalledOnce();
    // The stale error is cleared so the retry doesn't inherit it.
    expect(state.updates[0]).toMatchObject({ status: 'approved', error: null });
  });

  it('rejects terminal statuses with 409', async () => {
    for (const status of ['published', 'rejected', 'approved']) {
      state.selects = [[{ ...action, status }]];
      const res = await approvePOST(req({}), ctx('s1'));
      expect(res.status).toBe(409);
    }
    expect(publishText).not.toHaveBeenCalled();
  });

  it('says reconnect instead of publishing with a token it knows is dead', async () => {
    state.selects = [[action], [{ ...ACCOUNT, isStub: false }]];
    // ensureFreshToken returns the STALE token when the provider refresh fails.
    freshToken = { lastRefreshError: 'invalid_grant', tokenExpiresAt: new Date(Date.now() - 1000) };

    const res = await approvePOST(req({}), ctx('s1'));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe('reconnect_needed');
    expect(publishText).not.toHaveBeenCalled();
    expect(statuses()).not.toContain('published');
  });
});

describe('POST /api/accounts', () => {
  it('refuses to mint a stub account outside development', async () => {
    // vitest runs with NODE_ENV=test, i.e. the production-shaped path.
    const res = await accountsPOST(req({ platform: 'x' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('stub_accounts_disabled');
    expect(state.inserts).toHaveLength(0);
  });
});
