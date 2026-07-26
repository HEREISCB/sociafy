import { describe, it, expect, beforeEach, vi } from 'vitest';

// The one thing about GET /api/keys that must never regress: the response
// cannot contain key_hash. The route enforces it by selecting an explicit
// column list, so the mock builds its rows from whatever columns were asked
// for — exactly like drizzle does — instead of inventing a shape.
const state = {
  selectedCols: {} as Record<string, unknown>,
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

beforeEach(() => {
  state.selectedCols = {};
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
