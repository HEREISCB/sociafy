import { describe, it, expect, beforeEach, vi } from 'vitest';

// withUser just invokes the handler with a fake user and returns its result.
vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (message: string, status = 400, extra?: Record<string, unknown>) => ({ error: message, status, ...extra }),
}));

const state = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  modalOk: false,
  ttsResult: { status: 'pending' } as { status: string; audioUrl?: string; error?: string },
  avatarResult: { status: 'pending' } as { status: string; videoUrl?: string; error?: string },
  refundCalls: [] as Record<string, unknown>[],
}));

vi.mock('../../../../lib/db', () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(state.job ? [state.job] : []) }) }) }),
    insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: () => { const row = { id: 'asset_1', ...v }; state.inserted.push(row); return Promise.resolve([row]); } }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: () => { state.updated.push(v); return Promise.resolve(); } }) }),
  }),
}));

vi.mock('../../../../lib/db/schema', () => ({ genJobs: {}, mediaAssets: {} }));
vi.mock('drizzle-orm', () => ({ and: (...a: unknown[]) => a, eq: (_c: unknown, v: unknown) => v }));
vi.mock('../../../../lib/storage/r2', () => ({ keyFromPublicUrl: (u: string) => `key:${u}` }));
vi.mock('../../../../lib/credits/ledger', () => ({ refund: (a: Record<string, unknown>) => { state.refundCalls.push(a); return Promise.resolve(); } }));
vi.mock('../../../../lib/ai/modal', () => ({
  modalConfigured: () => state.modalOk,
  getTtsResult: () => Promise.resolve(state.ttsResult),
  getAvatarResult: () => Promise.resolve(state.avatarResult),
}));

import { GET } from './[id]/route';

function call() {
  return GET({} as never, { params: Promise.resolve({ id: 'job_1' }) }) as unknown as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  state.job = null; state.inserted = []; state.updated = []; state.modalOk = false;
  state.ttsResult = { status: 'pending' }; state.avatarResult = { status: 'pending' }; state.refundCalls = [];
});

describe('GET /api/media/gen-job/[id]', () => {
  it('404s when the job is missing', async () => {
    const res = await call();
    expect(res.error).toBe('job_not_found');
  });

  it('stub-finalizes a pending tts job to a placeholder asset', async () => {
    state.job = { id: 'job_1', kind: 'tts', status: 'pending', providerCallId: 'stub', mediaAssetId: null };
    const res = await call();
    expect(res.status).toBe('completed');
    expect(res.stub).toBe(true);
    expect(state.inserted[0].publicUrl).toBe('/stub/tts.wav');
    expect(state.updated[0].status).toBe('completed');
  });

  it('refunds and marks failed when the avatar engine fails', async () => {
    state.modalOk = true;
    state.avatarResult = { status: 'failed', error: 'oom' };
    state.job = { id: 'job_1', kind: 'avatar', status: 'pending', providerCallId: 'c1', mediaAssetId: null, creditLedgerId: 'led_1' };
    const res = await call();
    expect(res.status).toBe('failed');
    expect(state.refundCalls).toHaveLength(1);
    expect(state.refundCalls[0].ledgerId).toBe('led_1');
    expect(state.updated[0].status).toBe('failed');
  });

  it('records the R2 asset when the engine completes', async () => {
    state.modalOk = true;
    state.avatarResult = { status: 'done', videoUrl: 'https://cdn/x.mp4' };
    state.job = { id: 'job_1', kind: 'avatar', status: 'pending', providerCallId: 'c1', mediaAssetId: null };
    const res = await call();
    expect(res.status).toBe('completed');
    expect(state.inserted[0].publicUrl).toBe('https://cdn/x.mp4');
    expect(state.inserted[0].storageKey).toBe('key:https://cdn/x.mp4');
  });
});
