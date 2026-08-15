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
  patches: [] as Record<string, unknown>[],
}));

vi.mock('../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => {
          const rows = state.row ? [state.row] : [];
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

import { PATCH } from './[id]/route';

const soon = () => new Date(Date.now() + 3_600_000).toISOString();
const patch = (body: Record<string, unknown>) =>
  PATCH({ json: async () => body } as unknown as NextRequest, { params: Promise.resolve({ id: 'sp1' }) });

beforeEach(() => {
  state.row = { id: 'sp1', userId: 'u1', status: 'failed', attempts: 3, error: 'youtube_text_unsupported' };
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

  it('refuses to move a post that is mid-publish', async () => {
    state.row!.status = 'publishing';
    const res = await patch({ scheduledAt: soon() });
    expect(res.status).toBe(400);
    expect(state.patches).toEqual([]);
  });
});
