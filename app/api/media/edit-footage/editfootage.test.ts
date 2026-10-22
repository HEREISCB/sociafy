import { describe, it, expect, beforeEach, vi } from 'vitest';

/** POST /api/media/edit-footage: clip checks happen before anything is charged. */
const st = vi.hoisted(() => ({
  heads: {} as Record<string, { size: number; contentType: string } | null>,
  calls: [] as Record<string, unknown>[],
}));

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));
vi.mock('../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('../../../../lib/env', () => ({ isStubMode: { r2: () => false } }));
vi.mock('../../../../lib/ai/motionAi', () => ({ motionAiConfigured: () => true }));
vi.mock('../../../../lib/credits/ledger', () => ({ InsufficientCreditsError: class extends Error {}, insufficientCreditsResponse: () => ({ status: 402 }) }));
vi.mock('../../../../lib/storage/r2', () => ({
  headObject: (k: string) => Promise.resolve(st.heads[k] ?? null),
  publicUrlFor: (k: string) => `https://cdn.example/${k}`,
}));
vi.mock('../../../../lib/media/motionJob', () => ({
  submitFootageEdit: (a: Record<string, unknown>) => {
    st.calls.push(a);
    return Promise.resolve({ job: { id: 'job_1', status: 'pending', durationSec: 60, aspect: a.aspect }, creditsCharged: 1080 });
  },
}));

import { POST } from './route';

const post = (body: unknown) =>
  POST(new Request('http://x/api/media/edit-footage', { method: 'POST', body: JSON.stringify(body) }) as never) as unknown as Promise<Response & { error?: string; status: number }>;

const KEY = 'users/user_1/abc-raw-take.mov';
beforeEach(() => {
  st.heads = { [KEY]: { size: 500 * 1024 ** 2, contentType: 'video/quicktime' } };
  st.calls = [];
});

describe('POST /api/media/edit-footage', () => {
  it('submits checked clips as public URLs, with the default ask when the box is empty', async () => {
    const r = await post({ clips: [{ key: KEY, name: 'take.mov' }], aspect: '9:16', lengthSec: null, sourceSec: 14.2, music: true });
    expect(r.status).toBe(202);
    expect(st.calls[0]).toMatchObject({
      userId: 'user_1', aspect: '9:16', lengthSec: null, sourceSec: 14.2, music: true, sfx: false,
      clips: [{ url: `https://cdn.example/${KEY}`, name: 'take.mov' }],
    });
    expect(String(st.calls[0].instructions)).toMatch(/pauses/);
  });

  it("refuses another user's key, a missing object, a non-video and an oversized file — before charging", async () => {
    st.heads['users/user_1/big.mp4'] = { size: 1024 ** 3 + 1, contentType: 'video/mp4' };
    st.heads['users/user_1/doc.mp4'] = { size: 10, contentType: 'application/pdf' };
    expect(await post({ clips: [{ key: 'users/user_2/x.mp4' }] })).toMatchObject({ error: 'bad_clip', status: 400 });
    expect(await post({ clips: [{ key: 'users/user_1/../user_2/x.mp4' }] })).toMatchObject({ error: 'bad_clip' });
    expect(await post({ clips: [{ key: 'users/user_1/gone.mp4' }] })).toMatchObject({ error: 'clip_missing' });
    st.heads['users/user_1/empty.mp4'] = { size: 0, contentType: 'video/mp4' }; // an aborted PUT
    expect(await post({ clips: [{ key: 'users/user_1/empty.mp4' }] })).toMatchObject({ error: 'clip_missing' });
    expect(await post({ clips: [{ key: 'users/user_1/big.mp4' }] })).toMatchObject({ error: 'clip_too_large' });
    expect(await post({ clips: [{ key: 'users/user_1/doc.mp4' }] })).toMatchObject({ error: 'clip_unsupported' });
    expect(st.calls).toHaveLength(0);
  });

  it('takes 1–5 clips and a length inside the motion range', async () => {
    expect((await post({ clips: [] })).status).toBe(400);
    expect((await post({ clips: Array(6).fill({ key: KEY }) })).status).toBe(400);
    expect((await post({ clips: [{ key: KEY }], lengthSec: 5 })).status).toBe(400);
    expect((await post({ clips: [{ key: KEY }], lengthSec: 30, instructions: 'Add captions' })).status).toBe(202);
    expect(st.calls[0]).toMatchObject({ lengthSec: 30, instructions: 'Add captions' });
  });
});
