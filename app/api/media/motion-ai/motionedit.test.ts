import { describe, it, expect, beforeEach, vi } from 'vitest';

/** POST /api/media/motion-ai/[jobId]/edit: gating, ownership, dispatch, white-label errors. */
const J1 = '11111111-1111-4111-8111-111111111111';
const st = vi.hoisted(() => ({
  configured: true,
  jobs: [] as Record<string, unknown>[],
  calls: [] as Record<string, unknown>[],
  fail: null as null | Error,
}));

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));
vi.mock('../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('../../../../lib/env', () => ({ isStubMode: { r2: () => false } }));
vi.mock('../../../../lib/ai/motionAi', () => ({ motionAiConfigured: () => st.configured }));
vi.mock('../../../../lib/credits/ledger', () => ({ InsufficientCreditsError: class extends Error {}, insufficientCreditsResponse: () => ({ status: 402 }) }));
// Ownership lives in the query: only this user's motion-claude rows, by job or asset id.
vi.mock('../../../../lib/media/motionVersions', () => ({
  findMotionJob: (userId: string, id: string) =>
    Promise.resolve(st.jobs.find((j) => j.userId === userId && (j.id === id || j.mediaAssetId === id)) ?? null),
}));
vi.mock('../../../../lib/media/motionJob', () => ({
  submitMotionAiEdit: (a: Record<string, unknown>) => {
    st.calls.push(a);
    if (st.fail) return Promise.reject(st.fail);
    return Promise.resolve({ job: { id: 'edit_1', status: 'pending', durationSec: 15, aspect: '9:16' }, creditsCharged: 135 });
  },
}));

import { POST } from './[jobId]/edit/route';

const post = (jobId: string, body: unknown) =>
  POST(new Request(`http://x/api/media/motion-ai/${jobId}/edit`, { method: 'POST', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ jobId }) }) as unknown as Promise<Response & { error?: string; hint?: string; status: number }>;

const done = { id: J1, userId: 'user_1', provider: 'motion-claude', status: 'completed', mediaAssetId: 'a1', providerTaskId: 'call-1', durationSec: 15, aspect: '9:16' };

beforeEach(() => { st.configured = true; st.jobs = [{ ...done }]; st.calls = []; st.fail = null; });

describe('POST /api/media/motion-ai/[jobId]/edit', () => {
  it('submits the edit against the parent job and answers 202', async () => {
    const r = await post(J1, { instruction: '  Make the logo bigger ', segmentId: 'seg-2' });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ job: { id: 'edit_1', creditsCharged: 135 } });
    expect(st.calls[0]).toMatchObject({ userId: 'user_1', instruction: 'Make the logo bigger', segmentId: 'seg-2', parent: { id: J1, providerTaskId: 'call-1' } });
  });

  it("404s when the worker isn't configured, or the job isn't the caller's finished render", async () => {
    st.configured = false;
    expect(await post(J1, { instruction: 'x' })).toMatchObject({ status: 404 });
    st.configured = true;
    st.jobs = [{ ...done, userId: 'someone_else' }];
    expect(await post(J1, { instruction: 'x' })).toMatchObject({ status: 404 });
    st.jobs = [{ ...done, status: 'pending', mediaAssetId: null }];
    expect(await post(J1, { instruction: 'x' })).toMatchObject({ status: 404 });
    expect(await post('not-a-uuid', { instruction: 'x' })).toMatchObject({ status: 404 });
    expect(st.calls).toHaveLength(0);
  });

  it('rejects an empty or over-long instruction before anything is charged', async () => {
    expect((await post(J1, { instruction: '   ' })).status).toBe(400);
    expect((await post(J1, { instruction: 'x'.repeat(1_001) })).status).toBe(400);
    expect(st.calls).toHaveLength(0);
  });

  it('never leaks worker text: a gone parent is 409, anything else 502', async () => {
    st.fail = new Error('motion_ai_404: {"error":"parent_not_found"}');
    const gone = await post(J1, { instruction: 'x' });
    expect(gone).toMatchObject({ status: 409, error: 'edit_unavailable' });
    expect(JSON.stringify(gone)).not.toContain('parent_not_found');
    st.fail = new Error('motion_ai_500: claude exploded');
    const boom = await post(J1, { instruction: 'x' });
    expect(boom).toMatchObject({ status: 502, error: 'video_submit_failed' });
    expect(JSON.stringify(boom).toLowerCase()).not.toContain('claude');
  });
});
