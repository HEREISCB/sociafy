import { describe, it, expect, beforeEach, vi } from 'vitest';

// The one thing about GET /api/keys that must never regress: the response
// cannot contain key_hash. The route enforces it by selecting an explicit
// column list, so the mock builds its rows from whatever columns were asked
// for — exactly like drizzle does — instead of inventing a shape.
const state = {
  selectedCols: {} as Record<string, unknown>,
  updates: [] as Record<string, unknown>[],
  /** Whether the tenant-scoped UPDATE matches a row. */
  updateHits: true,
};

vi.mock('../../../lib/db', () => ({
  db: () => ({
    select: (cols: Record<string, unknown>) => {
      state.selectedCols = cols;
      const rows = [Object.fromEntries(Object.keys(cols).map((k) => [k, `v_${k}`]))];
      return {
        from: () => ({
          where: () => ({ orderBy: () => Promise.resolve(rows) }),
        }),
      };
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            state.updates.push(v);
            return Promise.resolve(state.updateHits ? [{ id: 'key-1', ...v }] : []);
          },
        }),
      }),
    }),
  }),
}));

// Avoid pulling Clerk / next-server into the test; withUser's own behaviour is
// covered by lib/api.test.ts.
vi.mock('../../../lib/api', () => ({
  withUser: async (handler: (u: { id: string }) => unknown) => {
    const r = await handler({ id: 'user_abc' });
    return r instanceof Response ? r : Response.json(r);
  },
  jsonError: (error: string, status = 400) =>
    new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } }),
}));

import { GET } from './route';
import { PATCH } from './[id]/route';

beforeEach(() => {
  state.selectedCols = {};
  state.updates.length = 0;
  state.updateHits = true;
});

describe('GET /api/keys', () => {
  it('never selects or returns the key hash', async () => {
    const res = await GET({} as never);
    const body = (await res.json()) as Record<string, unknown>[];

    expect(Object.keys(state.selectedCols)).toEqual([
      'id', 'name', 'prefix', 'dailyCreditCap', 'lastUsedAt', 'createdAt',
    ]);
    expect(Object.keys(body[0])).not.toContain('keyHash');
    expect(JSON.stringify(body)).not.toContain('key_hash');
  });
});

/**
 * W2/W3: the API's daily_cap_exceeded hint and docs/api.md both told developers
 * to raise the cap in the dashboard, and no route or control could do it. Until
 * this existed the hint was a dead end.
 */
describe('PATCH /api/keys/[id]', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const call = (body: unknown, keyId = id) =>
    PATCH(
      new Request(`https://sociafy.app/api/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as never,
      { params: Promise.resolve({ id: keyId }) },
    );

  it('updates the daily credit cap', async () => {
    const res = await call({ dailyCreditCap: 12_000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dailyCreditCap: 12_000 });
    expect(state.updates).toEqual([{ dailyCreditCap: 12_000 }]);
  });

  it('rejects a cap outside the accepted bounds without touching the row', async () => {
    for (const bad of [0, -1, 100_001, 1.5, 'lots']) {
      expect((await call({ dailyCreditCap: bad })).status).toBe(400);
    }
    expect(state.updates).toHaveLength(0);
  });

  it('404s a non-uuid id rather than letting Postgres 500 on the cast', async () => {
    expect((await call({ dailyCreditCap: 5_000 }, 'not-a-uuid')).status).toBe(404);
    expect(state.updates).toHaveLength(0);
  });

  it('404s another tenant\'s or a revoked key (the WHERE clause is the scope)', async () => {
    state.updateHits = false;
    expect((await call({ dailyCreditCap: 5_000 })).status).toBe(404);
  });
});
