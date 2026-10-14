/**
 * Rescheduling a FAILED post has to actually requeue it. The cron only claims
 * rows with status='pending', so a failed row given a new time used to display
 * the new time and never publish again — a silent dead end.
 *
 * And rescheduling must never touch a row that is already live: flipping a
 * 'published' row back to 'pending' would hand it to the next tick for a
 * second publish to the customer's real account.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  /** The user's connected accounts — the select with an `id` column list. */
  accounts: [] as Record<string, unknown>[],
  patches: [] as Record<string, unknown>[],
}));

vi.mock('../../../lib/db', () => ({
  db: () => ({
    select: (cols?: unknown) => ({
      from: () => ({
        where: () => {
          const isAccounts = !!cols && 'id' in (cols as object);
          const rows = isAccounts ? state.accounts : state.row ? [state.row] : [];
          return Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        state.patches.push(v);
        return { where: () => ({ returning: () => Promise.resolve([{ ...state.row, ...v }]) }) };
      },
    }),
  }),
}));

vi.mock('../../../lib/api', () => ({
  jsonError: (message: string, status = 400, extra?: Record<string, unknown>) =>
    NextResponse.json({ error: message, ...extra }, { status }),
  withUser: async (handler: (u: { id: string }) => unknown) => {
    const result = await handler({ id: 'u1' });
    return result instanceof Response ? result : NextResponse.json(result);
  },
}));

import { PATCH, DELETE } from './[id]/route';

const soon = () => new Date(Date.now() + 3_600_000).toISOString();
const del = () =>
  DELETE({} as unknown as NextRequest, { params: Promise.resolve({ id: 'sp1' }) });
const patch = (body: Record<string, unknown>) =>
  PATCH({ json: async () => body } as unknown as NextRequest, { params: Promise.resolve({ id: 'sp1' }) });

beforeEach(() => {
  state.row = { id: 'sp1', userId: 'u1', accountId: 'a1', platform: 'x', status: 'failed', attempts: 3, error: 'youtube_text_unsupported' };
  state.accounts = [];
  state.patches = [];
});

describe('PATCH /api/schedule/[id]', () => {
  it('requeues a failed post and clears its error and attempt count', async () => {
    const res = await patch({ scheduledAt: soon() });
    expect(res.status).toBe(200);
    expect(state.patches[0]).toMatchObject({ status: 'pending', attempts: 0, error: null });
  });

  it('leaves a pending post pending', async () => {
    state.row!.status = 'pending';
    state.row!.attempts = 1;
    await patch({ scheduledAt: soon() });
    expect(state.patches[0].status).toBeUndefined();
    expect(state.patches[0].attempts).toBeUndefined();
  });

  it('refuses to move a post that already published', async () => {
    state.row!.status = 'published';
    const res = await patch({ scheduledAt: soon() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('already_published');
    expect(state.patches).toEqual([]);
  });

  it('requeues a post the user canceled', async () => {
    state.row = { ...state.row, status: 'canceled', error: 'user_canceled' };
    await patch({ scheduledAt: soon() });
    expect(state.patches[0]).toMatchObject({ status: 'pending', attempts: 0, error: null });
  });

  it('refuses to requeue a post canceled by Post now or a disconnect (double post)', async () => {
    for (const error of ['superseded_by_post_now', 'account_disconnected', null]) {
      state.row = { ...state.row, status: 'canceled', error };
      const res = await patch({ scheduledAt: soon() });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('not_restorable');
    }
    expect(state.patches).toEqual([]);
  });

  it('refuses to cancel a post that is mid-publish or live', async () => {
    for (const status of ['publishing', 'published']) {
      state.row!.status = status;
      const res = await patch({ status: 'canceled' });
      expect(res.status).toBe(409);
    }
    expect(state.patches).toEqual([]);
  });

  it('refuses to move a post that is mid-publish', async () => {
    state.row!.status = 'publishing';
    const res = await patch({ scheduledAt: soon() });
    expect(res.status).toBe(400);
    expect(state.patches).toEqual([]);
  });

  it('relinks a canceled post whose account was disconnected', async () => {
    state.row = { ...state.row, status: 'canceled', error: 'user_canceled', accountId: null };
    state.accounts = [{ id: 'a2' }];
    const res = await patch({ scheduledAt: soon() });
    expect(res.status).toBe(200);
    expect(state.patches[0]).toMatchObject({ status: 'pending', accountId: 'a2' });
  });

  it('refuses to requeue when no account is connected for the platform', async () => {
    state.row = { ...state.row, status: 'canceled', error: 'user_canceled', accountId: null };
    const res = await patch({ scheduledAt: soon() });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('account_disconnected');
    expect(state.patches).toEqual([]);
  });
});

describe('DELETE /api/schedule/[id] (soft cancel)', () => {
  it('marks a pending post canceled instead of deleting it', async () => {
    state.row!.status = 'pending';
    const res = await del();
    expect(res.status).toBe(200);
    expect(state.patches[0]).toMatchObject({ status: 'canceled', error: 'user_canceled' });
    expect((await res.json()).status).toBe('canceled');
  });

  it('cancels a failed post', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(state.patches[0]).toMatchObject({ status: 'canceled' });
  });

  it('refuses to cancel a post that is publishing, published or already canceled', async () => {
    for (const status of ['publishing', 'published', 'canceled']) {
      state.row!.status = status;
      const res = await del();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('not_cancelable');
    }
    expect(state.patches).toEqual([]);
  });

  it('404s for a post that is not the user\'s', async () => {
    state.row = null;
    const res = await del();
    expect(res.status).toBe(404);
  });
});
