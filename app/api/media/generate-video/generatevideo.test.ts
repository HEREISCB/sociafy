import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Guards the ordering invariant: the video_jobs row and the credit charge must
 * both exist BEFORE we hand a task to PiAPI, so an accepted-but-unacknowledged
 * submission can never be an invisible provider bill.
 */

const state = vi.hoisted(() => ({
  calls: [] as string[],
  rows: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  submitError: null as Error | null,
  r2Stub: false,
  refDurationS: 12 as number | null,
}));

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));

vi.mock('../../../../lib/db', () => ({
  db: () => ({
    // Reference mode looks up the caller's own upload to price the input-duration
    // surcharge; `refDurationS = null` exercises the fail-closed unknown path.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ durationS: state.refDurationS }]),
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          state.calls.push('insert');
          const row = { id: `job_${state.rows.length + 1}`, ...v };
          state.rows.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(v);
          return {
            returning: () => Promise.resolve([{ ...state.rows[state.rows.length - 1], ...v }]),
            then: (r: (x: unknown) => unknown) => Promise.resolve(undefined).then(r),
          };
        },
      }),
    }),
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (_c: unknown, v: unknown) => v,
  and: (...cs: unknown[]) => cs,
}));
vi.mock('../../../../lib/db/schema', () => ({
  videoJobs: { id: 'id' },
  mediaAssets: { durationS: 'durationS', userId: 'userId', storageKey: 'storageKey' },
}));
vi.mock('../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('../../../../lib/ai/client', () => ({ getOpenAI: () => ({}) }));
vi.mock('../../../../lib/env', () => ({ isStubMode: { r2: () => state.r2Stub } }));
vi.mock('../../../../lib/storage/r2', () => ({
  keyFromPublicUrl: (u: string) => (u.startsWith('https://cdn.test/') ? u.slice('https://cdn.test/'.length) : u),
}));
vi.mock('../../../../lib/ai/prompt-rewriter', () => ({
  rewritePromptForMedia: () => Promise.resolve({ prompt: 'rewritten', enhanced: true }),
}));
vi.mock('../../../../lib/ai/brand-context', () => ({
  loadBrandContext: () => Promise.resolve(null),
  renderBrandBlock: () => '',
}));
vi.mock('../../../../lib/validation', () => ({
  parseBody: (schema: { safeParse: (r: unknown) => { success: boolean; data?: unknown } }, raw: unknown) => {
    const p = schema.safeParse(raw);
    return p.success ? { ok: true, data: p.data } : { ok: false, response: { error: 'invalid_body', status: 400 } };
  },
}));
vi.mock('../../../../lib/credits/pricing', () => ({
  priceForVideo: () => ({ action: 'video_8s_720p_quality', credits: 180 }),
}));
vi.mock('../../../../lib/ai/piapi', () => ({
  createSeedanceTask: () => {
    state.calls.push('submit');
    if (state.submitError) return Promise.reject(state.submitError);
    return Promise.resolve('task_abc');
  },
}));
vi.mock('../../../../lib/credits/ledger', () => ({
  ensureBalance: () => Promise.resolve({ ok: true, balance: 10_000 }),
  charge: () => { state.calls.push('charge'); return Promise.resolve({ ledgerId: 'led_1', balanceAfter: 9_820 }); },
  refund: (a: Record<string, unknown>) => { state.refunds.push(a); return Promise.resolve({ refunded: true }); },
  insufficientCreditsResponse: () => ({ error: 'insufficient_credits', status: 402 }),
}));

import { POST } from './route';

function call(body: Record<string, unknown>) {
  return POST({ json: async () => body } as never) as unknown as Promise<Response & Record<string, unknown>>;
}

beforeEach(() => {
  process.env.PIAPI_API_KEY = 'k';
  state.calls = []; state.rows = []; state.updates = []; state.refunds = [];
  state.submitError = null; state.r2Stub = false; state.refDurationS = 12;
});

describe('POST /api/media/generate-video', () => {
  it('inserts the job row and charges before submitting to PiAPI', async () => {
    const res = await call({ prompt: 'a cat on a skateboard' });
    expect(state.calls).toEqual(['insert', 'charge', 'submit']);
    // The row exists before submit, so it starts task-id-less.
    expect(state.rows[0].providerTaskId).toBe('');
    expect(state.updates.some((u) => u.providerTaskId === 'task_abc')).toBe(true);
    const body = await res.json();
    expect(body.submitted).toBe(1);
    expect(body.jobs[0].creditsCharged).toBe(180);
  });

  it('keeps the row pending and does NOT refund when the submit times out ambiguously', async () => {
    state.submitError = new Error('ETIMEDOUT');
    const res = await call({ prompt: 'a cat on a skateboard' });
    expect(state.refunds).toHaveLength(0);
    expect(state.updates.some((u) => String(u.error ?? '').startsWith('submit_unconfirmed'))).toBe(true);
    expect(state.updates.some((u) => u.status === 'failed')).toBe(false);
    // Still reported as submitted — the cron sweeper owns closing it out.
    const body = await res.json();
    expect(body.submitted).toBe(1);
  });

  it('fails the row and refunds on a definitive PiAPI rejection', async () => {
    state.submitError = new Error('piapi_400: bad prompt');
    const res = await call({ prompt: 'a cat on a skateboard' });
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0].ledgerId).toBe('led_1');
    expect(state.updates.some((u) => u.status === 'failed')).toBe(true);
    expect(res.error).toBe('video_submit_failed');
  });

  it('refuses to run at all when R2 is unconfigured (no charge, no submit)', async () => {
    state.r2Stub = true;
    const res = await call({ prompt: 'a cat on a skateboard' });
    expect(res.error).toBe('r2_not_configured');
    expect(state.calls).toEqual([]);
  });

  it('rejects a reference video that is not the caller own upload', async () => {
    const res = await call({
      prompt: 'a cat on a skateboard',
      genMode: 'reference',
      referenceVideoUrl: 'https://evil.example/8-hour-loop.mp4',
    });
    expect(res.error).toBe('reference_video_must_be_uploaded');
    expect(state.calls).toEqual([]);
  });

  it('clamps count to 1 when a reference video is supplied', async () => {
    const res = await call({
      prompt: 'a cat on a skateboard',
      genMode: 'reference',
      count: 3,
      referenceVideoUrl: 'https://cdn.test/users/user_1/clip.mp4',
    });
    expect(state.calls.filter((c) => c === 'submit')).toHaveLength(1);
    const body = await res.json();
    expect(body.submitted).toBe(1);
  });
});
