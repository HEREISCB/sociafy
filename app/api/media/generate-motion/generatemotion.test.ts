import { describe, it, expect, beforeEach, vi } from 'vitest';

/** POST /api/media/generate-motion: per-kind 404 gating and the 'ai' dispatch. */
const st = vi.hoisted(() => ({
  motion: true,
  motionAi: true,
  ai: [] as Record<string, unknown>[],
  tpl: [] as Record<string, unknown>[],
}));

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));
vi.mock('../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('../../../../lib/env', () => ({ isStubMode: { r2: () => false } }));
vi.mock('../../../../lib/ai/motion', () => ({ motionConfigured: () => st.motion }));
vi.mock('../../../../lib/ai/motionAi', () => ({ motionAiConfigured: () => st.motionAi }));
vi.mock('../../../../lib/credits/ledger', () => ({ InsufficientCreditsError: class extends Error {}, insufficientCreditsResponse: () => ({ status: 402 }) }));
vi.mock('../../../../lib/media/motionJob', () => {
  const job = (a: Record<string, unknown>) => ({ job: { id: 'job_1', status: 'pending', durationSec: a.durationSec ?? 15, aspect: a.aspect }, creditsCharged: 270 });
  return {
    MotionNotReady: class extends Error {},
    submitMotionAiVideo: (a: Record<string, unknown>) => { st.ai.push(a); return Promise.resolve(job(a)); },
    submitMotionVideo: (a: Record<string, unknown>) => { st.tpl.push(a); return Promise.resolve(job(a)); },
  };
});

import { POST } from './route';

const post = (body: unknown) =>
  POST(new Request('http://x/api/media/generate-motion', { method: 'POST', body: JSON.stringify(body) }) as never) as unknown as Promise<Response & { error?: string; status: number }>;

beforeEach(() => { st.motion = true; st.motionAi = true; st.ai = []; st.tpl = []; });

describe('POST /api/media/generate-motion', () => {
  it("routes template 'ai' to the AI worker with length and square", async () => {
    const r = await post({ topic: 'Hindi support is live', template: 'ai', aspect: '1:1', durationSec: 12 });
    expect(r.status).toBe(202);
    const body = await r.json();
    expect(body.model).toBe('AI-designed motion graphic');
    expect(st.ai[0]).toMatchObject({ userId: 'user_1', aspect: '1:1', durationSec: 12, via: 'compose' });
    expect(st.tpl).toHaveLength(0);
  });

  it('404s the kind that is not configured, and refuses square templates', async () => {
    st.motionAi = false;
    expect(await post({ topic: 'Hello there', template: 'ai' })).toMatchObject({ error: 'not_found', status: 404 });
    expect((await post({ topic: 'Hello there', template: 'stat' })).status).toBe(202);
    expect(await post({ topic: 'Hello there', template: 'stat', aspect: '1:1' })).toMatchObject({ status: 400 });
    st.motion = false;
    expect(await post({ topic: 'Hello there', template: 'stat' })).toMatchObject({ error: 'not_found', status: 404 });
    expect(st.ai).toHaveLength(0);
  });

  it('passes the audio choice through to the AI worker, and validates it', async () => {
    const audio = { narration: true, sfx: true, music: false, language: 'hi' };
    expect((await post({ topic: 'Hindi support is live', template: 'ai', audio })).status).toBe(202);
    expect(st.ai[0]).toMatchObject({ audio });
    expect((await post({ topic: 'Hindi support is live', template: 'ai', audio: { sfx: true } })).status).toBe(202);
    expect(st.ai[1].audio).toEqual({ narration: false, sfx: true, music: false });
    expect((await post({ topic: 'Hindi support is live', template: 'ai' })).status).toBe(202);
    expect(st.ai[2].audio).toBeUndefined();
    expect((await post({ topic: 'Hello there', template: 'ai', audio: { narration: 'yes' } })).status).toBe(400);
    expect((await post({ topic: 'Hello there', template: 'ai', audio: { narration: true, voice: '<script>' } })).status).toBe(400);
    expect(st.ai).toHaveLength(3);
  });

  it('rejects an out-of-range length', async () => {
    expect((await post({ topic: 'Hello there', template: 'ai', durationSec: 30 })).status).toBe(400);
    expect(st.ai).toHaveLength(0);
  });
});
