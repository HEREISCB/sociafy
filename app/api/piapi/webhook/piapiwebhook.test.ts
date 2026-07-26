import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The webhook is an unauthenticated internet endpoint that drives the finalize
 * path (store the MP4, or fail + refund). Everything here is about refusing to
 * run it for anyone who can't prove they're the provider.
 */

const SECRET = 'a'.repeat(32);

const state = vi.hoisted(() => ({
  jobs: [{ id: 'job_1', providerTaskId: 'task_abc', status: 'pending' }] as Record<string, unknown>[],
  finalized: [] as unknown[],
}));

vi.mock('../../../../lib/db/schema', () => ({
  videoJobs: { providerTaskId: { __name: 'providerTaskId' } },
}));
vi.mock('drizzle-orm', () => ({
  eq: (c: { __name: string }, v: unknown) => (r: Record<string, unknown>) => r[c.__name] === v,
}));
vi.mock('../../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => ({
          limit: () => Promise.resolve(state.jobs.filter((j) => pred(j))),
        }),
      }),
    }),
  }),
}));
vi.mock('../../../../lib/env', () => ({ isStubMode: { database: () => false } }));
vi.mock('../../../../lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true, remaining: 9, retryAfterSec: 0 }),
  requestIp: () => '1.2.3.4',
}));
vi.mock('../../../../lib/media/finalizeVideoJob', () => ({
  finalizeVideoJob: (job: unknown) => {
    state.finalized.push(job);
    return Promise.resolve({ status: 'completed' });
  },
}));

const { POST } = await import('./route');

function hit(opts: { secret?: string | null; body?: unknown; rawBody?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.secret) headers['x-webhook-secret'] = opts.secret;
  return POST(
    new Request('https://sociafy.test/api/piapi/webhook', {
      method: 'POST',
      headers,
      body: opts.rawBody ?? JSON.stringify(opts.body ?? {}),
    }) as never,
  );
}

const fresh = (taskId = 'task_abc') => ({
  timestamp: Math.floor(Date.now() / 1000),
  data: { task_id: taskId, status: 'completed' },
});

beforeEach(() => {
  state.finalized = [];
  process.env.PIAPI_WEBHOOK_SECRET = SECRET;
});

describe('POST /api/piapi/webhook', () => {
  it('finalizes a known task on a valid push', async () => {
    const res = await hit({ secret: SECRET, body: fresh() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'completed' });
    expect(state.finalized).toHaveLength(1);
  });

  it('rejects a wrong secret without parsing the body', async () => {
    // Unparseable body: if verification ran after parsing, this would 400.
    const res = await hit({ secret: 'b'.repeat(32), rawBody: '{not json' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_signature');
    expect(state.finalized).toHaveLength(0);
  });

  it('rejects a missing secret header', async () => {
    const res = await hit({ body: fresh() });
    expect(res.status).toBe(401);
    expect(state.finalized).toHaveLength(0);
  });

  it('rejects a length-mismatched secret (timingSafeEqual would throw)', async () => {
    const res = await hit({ secret: SECRET.slice(0, 8), body: fresh() });
    expect(res.status).toBe(401);
    expect(state.finalized).toHaveLength(0);
  });

  it('fails closed when the secret is unset or too short', async () => {
    delete process.env.PIAPI_WEBHOOK_SECRET;
    expect((await hit({ secret: SECRET, body: fresh() })).status).toBe(503);
    process.env.PIAPI_WEBHOOK_SECRET = 'tooshort';
    expect((await hit({ secret: 'tooshort', body: fresh() })).status).toBe(503);
    expect(state.finalized).toHaveLength(0);
  });

  it('rejects a replayed (stale) timestamp', async () => {
    const res = await hit({
      secret: SECRET,
      body: { timestamp: Math.floor(Date.now() / 1000) - 3_600, data: { task_id: 'task_abc' } },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('stale_timestamp');
    expect(state.finalized).toHaveLength(0);
  });

  it('2xxs an unknown task so the provider stops retrying, and leaks nothing', async () => {
    const res = await hit({ secret: SECRET, body: fresh('task_nope') });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(state.finalized).toHaveLength(0);
  });

  it('400s a payload with no task id', async () => {
    const res = await hit({ secret: SECRET, body: { timestamp: Math.floor(Date.now() / 1000), data: {} } });
    expect(res.status).toBe(400);
  });
});
