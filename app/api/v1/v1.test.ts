import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Money-critical invariants of the public v1 API:
 *   - the same Idempotency-Key charges ONCE and returns the SAME job
 *   - every charge carries meta.apiKeyId (the auth layer's spend cap reads it;
 *     omit it and the cap silently stops working)
 *   - reference-mode video is rejected (it is unpriceable today)
 *   - GET /api/v1/videos/{id} is tenant-scoped in its WHERE clause
 *
 * The db fake applies real predicates so the tenant scoping can actually fail.
 */

const col = (name: string) => ({ __name: name });

const state = vi.hoisted(() => ({
  userId: 'user_1',
  apiKeyId: 'key_1',
  jobs: [] as Record<string, unknown>[],
  ledger: [] as Record<string, unknown>[],
  charges: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  submits: [] as Record<string, unknown>[],
  submitError: null as Error | null,
  /** Simulates a database fault after the charge landed — not a provider
   *  rejection, and it must not be reported as one. */
  failUpdates: false,
}));

vi.mock('../../../lib/api-key', () => ({
  withApiKey: (_req: unknown, handler: (a: { userId: string; apiKeyId: string }) => unknown) =>
    Promise.resolve(handler({ userId: state.userId, apiKeyId: state.apiKeyId })),
}));

vi.mock('../../../lib/db/schema', () => ({
  videoJobs: {
    __t: 'jobs',
    id: col('id'), userId: col('userId'), providerTaskId: col('providerTaskId'), status: col('status'),
  },
  creditLedger: {
    __t: 'ledger',
    id: col('id'), userId: col('userId'), kind: col('kind'), credits: col('credits'),
    meta: col('meta'), createdAt: col('createdAt'),
  },
  mediaAssets: { __t: 'assets', id: col('id'), userId: col('userId'), publicUrl: col('publicUrl') },
  apiKeys: { __t: 'keys', id: col('id'), prefix: col('prefix'), dailyCreditCap: col('dailyCreditCap') },
}));

// Predicates become plain functions so the fake db can filter for real.
vi.mock('drizzle-orm', () => ({
  eq: (c: { __name: string }, v: unknown) => (r: Record<string, unknown>) => r[c.__name] === v,
  and: (...ps: unknown[]) => (r: Record<string, unknown>) =>
    ps.every((p) => (typeof p === 'function' ? (p as (x: unknown) => boolean)(r) : true)),
  gte: () => () => true,
  // Approximates only the two jsonb fragments shared.ts uses. Enough for the
  // idempotency lookup to resolve the right row; the real predicate is checked
  // by the unique index, which the `charge` fake below models.
  sql: (strings: string[], ...vals: unknown[]) => {
    const text = strings.join('?');
    if (text.includes("->>'source' = ")) {
      const want = vals[vals.length - 1];
      return (r: Record<string, unknown>) => (r.meta as { source?: unknown } | null)?.source === want;
    }
    if (text.includes('jsonb_exists')) {
      return (r: Record<string, unknown>) => (r.meta as { source?: unknown } | null)?.source !== undefined;
    }
    return () => true;
  },
}));

type Pred = (r: Record<string, unknown>) => boolean;
const storeFor = (t: { __t?: string }) => (t.__t === 'ledger' ? state.ledger : state.jobs);

vi.mock('../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: (t: { __t?: string }) => ({
        where: (pred: Pred) => ({
          limit: () => Promise.resolve(storeFor(t).filter((r) => pred(r))),
        }),
      }),
    }),
    insert: (t: { __t?: string }) => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          const store = storeFor(t);
          // uuid-shaped: the GET route rejects non-uuid ids before hitting the db.
          const n = String(store.length + 1).padStart(12, '0');
          const row = { id: `00000000-0000-4000-8000-${n}`, ...v };
          store.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
    update: (t: { __t?: string }) => ({
      set: (v: Record<string, unknown>) => ({
        where: (pred: Pred) => {
          if (state.failUpdates) throw new Error('db_connection_lost');
          const hit = storeFor(t).filter((r) => pred(r));
          for (const r of hit) Object.assign(r, v);
          return {
            returning: () => Promise.resolve(hit),
            then: (r: (x: unknown) => unknown) => Promise.resolve(undefined).then(r),
          };
        },
      }),
    }),
  }),
}));

vi.mock('../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true, remaining: 9, retryAfterSec: 0 }) }));
vi.mock('../../../lib/env', () => ({ isStubMode: { r2: () => false, database: () => false } }));

class InsufficientCreditsError extends Error {
  constructor(readonly balance: number, readonly needed: number) {
    super('insufficient_credits');
  }
}

vi.mock('../../../lib/credits/ledger', () => ({
  InsufficientCreditsError,
  getBalance: () => Promise.resolve(1_000),
  ensureBalance: () => Promise.resolve({ ok: true, balance: 1_000 }),
  refund: (a: Record<string, unknown>) => {
    state.refunds.push(a);
    return Promise.resolve({ refunded: true, balanceAfter: 1_000 });
  },
  // Models drizzle/0008's partial unique index on
  // (user_id, kind, meta->>'source') — the actual idempotency authority.
  charge: (a: { userId: string; credits: number; meta?: Record<string, unknown> }) => {
    state.charges.push(a as Record<string, unknown>);
    const source = a.meta?.source;
    if (source && state.ledger.some((r) => r.userId === a.userId && (r.meta as { source?: unknown })?.source === source)) {
      const e = new Error('duplicate key value violates unique constraint "credit_ledger_user_kind_source_uniq"');
      (e as unknown as { code: string }).code = '23505';
      return Promise.reject(e);
    }
    const row = {
      id: `ledger_${state.ledger.length + 1}`,
      userId: a.userId,
      kind: 'charge',
      credits: -a.credits,
      meta: a.meta ?? {},
    };
    state.ledger.push(row);
    return Promise.resolve({ ledgerId: row.id, balanceAfter: 1_000 });
  },
}));

vi.mock('../../../lib/ai/piapi', () => ({
  createSeedanceTask: (a: Record<string, unknown>) => {
    state.submits.push(a);
    if (state.submitError) return Promise.reject(state.submitError);
    return Promise.resolve(`task_${state.submits.length}`);
  },
}));

vi.mock('../../../lib/media/finalizeVideoJob', () => ({
  finalizeVideoJob: (job: Record<string, unknown>) => Promise.resolve({ status: job.status ?? 'pending' }),
}));

const { POST } = await import('./videos/route');
const { GET } = await import('./videos/[id]/route');

function post(body: unknown, idempotencyKey?: string) {
  return POST(
    new Request('https://sociafy.test/api/v1/videos', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    }) as never,
  );
}

beforeEach(() => {
  state.userId = 'user_1';
  state.apiKeyId = 'key_1';
  state.jobs = [];
  state.ledger = [];
  state.charges = [];
  state.refunds = [];
  state.submits = [];
  state.submitError = null;
  state.failUpdates = false;
  process.env.PIAPI_API_KEY = 'test-key';
  delete process.env.PIAPI_WEBHOOK_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe('POST /api/v1/videos', () => {
  it('accepts a text-to-video submit and charges once with meta.apiKeyId', async () => {
    const res = await post({ prompt: 'a cat surfing', duration_sec: 8, quality: '720p' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('pending');
    expect(body.credits_charged).toBe(180); // 8s / 720p / quality
    expect(body.poll_url).toBe(`/api/v1/videos/${body.id}`);

    expect(state.charges).toHaveLength(1);
    // Without this the auth layer's daily-cap query matches nothing.
    expect((state.charges[0] as { meta: Record<string, unknown> }).meta.apiKeyId).toBe('key_1');
    expect(state.submits).toHaveLength(1);
  });

  it('never exposes the upstream task id or provider', async () => {
    const res = await post({ prompt: 'a cat surfing' });
    const text = await res.text();
    expect(text).not.toMatch(/piapi|seedance|task_/i);
  });

  it('charges once and returns the same job for a repeated Idempotency-Key', async () => {
    const first = await post({ prompt: 'a cat surfing' }, 'client-key-0001');
    const second = await post({ prompt: 'a cat surfing' }, 'client-key-0001');

    const a = await first.json();
    const b = await second.json();
    expect(a.id).toBe(b.id);
    expect(b.credits_charged).toBe(a.credits_charged);
    expect(second.headers.get('idempotency-replay')).toBe('true');

    // One ledger row, one provider submission — the whole point.
    expect(state.ledger).toHaveLength(1);
    expect(state.submits).toHaveLength(1);
    expect(state.refunds).toHaveLength(0);
  });

  // W7/W8: a replay used to hardcode "pending" and echo the NEW request's
  // parameters, so replaying a key whose job finished last week reported a
  // pending job with mixed params and the original's price.
  it('reports the ORIGINAL job\'s real status and parameters on a replay', async () => {
    const first = await (await post(
      { prompt: 'a cat surfing', duration_sec: 8, quality: '720p', aspect: '9:16' },
      'client-key-0003',
    )).json();

    // The job finishes out-of-band, as it would in production.
    state.jobs[0].status = 'completed';

    const replay = await post(
      { prompt: 'something else', duration_sec: 15, quality: '1080p', aspect: '16:9' },
      'client-key-0003',
    );
    const body = await replay.json();
    expect(replay.headers.get('idempotency-replay')).toBe('true');
    expect(body.id).toBe(first.id);
    expect(body.status).toBe('completed');
    expect(body.duration_sec).toBe(8);
    expect(body.quality).toBe('720p');
    expect(body.aspect).toBe('9:16');
    expect(body.credits_charged).toBe(first.credits_charged);
    expect(state.ledger).toHaveLength(1);
  });

  it('surfaces the public error code when a replay resolves to a failed job', async () => {
    await post({ prompt: 'a cat surfing' }, 'client-key-0004');
    state.jobs[0].status = 'failed';
    state.jobs[0].error = 'submit_failed: piapi_400 {"detail":"nope"}';

    const body = await (await post({ prompt: 'a cat surfing' }, 'client-key-0004')).json();
    expect(body.status).toBe('failed');
    expect(body.error).toBe('generation_rejected');
    expect(JSON.stringify(body)).not.toMatch(/piapi|nope/i);
  });

  it('scopes the idempotency source to the endpoint', async () => {
    await post({ prompt: 'a cat surfing' }, 'shared-key-0001');
    expect((state.charges[0] as { meta: { source: string } }).meta.source).toBe('api:videos:shared-key-0001');
  });

  it('409s rather than 502s when a charge exists but no job resolves from it', async () => {
    // The unique index fires but replayOf finds nothing — an in-flight twin owns
    // the key. Previously this fell into the generic "provider rejected" 502.
    state.ledger.push({
      id: 'ledger_x', userId: 'user_1', kind: 'charge', credits: -180,
      meta: { source: 'api:videos:client-key-0005' }, // no videoJobId
    });
    const res = await post({ prompt: 'a cat surfing' }, 'client-key-0005');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('request_in_progress');
  });

  it('treats a different Idempotency-Key as a new job', async () => {
    await post({ prompt: 'a' .repeat(10) }, 'client-key-0001');
    await post({ prompt: 'a' .repeat(10) }, 'client-key-0002');
    expect(state.ledger).toHaveLength(2);
    expect(state.submits).toHaveLength(2);
  });

  it('rejects reference mode without charging', async () => {
    const res = await post({ prompt: 'a cat surfing', gen_mode: 'reference' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
    expect(state.charges).toHaveLength(0);
  });

  it('rejects unknown fields rather than silently billing a default', async () => {
    const res = await post({ prompt: 'a cat surfing', reference_video_url: 'https://x/y.mp4' });
    expect(res.status).toBe(400);
    expect(state.charges).toHaveLength(0);
  });

  it('rejects a malformed Idempotency-Key instead of ignoring it', async () => {
    const res = await post({ prompt: 'a cat surfing' }, 'short');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_idempotency_key');
    expect(state.charges).toHaveLength(0);
  });

  it('refunds and returns a neutral 502 when the provider definitively rejects', async () => {
    state.submitError = new Error('piapi_400: {"message":"bad prompt"}');
    const res = await post({ prompt: 'a cat surfing' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('upstream_error');
    expect(JSON.stringify(body)).not.toMatch(/piapi|bad prompt/i);
    expect(state.refunds).toHaveLength(1);
    // W5: the old copy said "No credits were charged", which was false —
    // credits are charged and then refunded (shared.ts refunds on this path).
    expect(body.message).not.toMatch(/no credits were charged/i);
    expect(body.message).toMatch(/refunded/i);
  });

  // W5: a DB fault after the charge is not a provider rejection, and claiming it
  // was told the caller their money was safe when it might not be.
  it('does not dress a post-charge database fault up as a provider rejection', async () => {
    state.failUpdates = true;
    const res = await post({ prompt: 'a cat surfing' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal');
    expect(body.message).toMatch(/our side/i);
    expect(body.message).not.toMatch(/provider rejected/i);
  });

  it('carries a human message on every error response', async () => {
    const responses = [
      await post({ prompt: 'x' }),                        // invalid_request
      await post({ prompt: 'a cat surfing' }, 'nope'),    // invalid_idempotency_key
    ];
    state.submitError = new Error('piapi_400: nope');
    responses.push(await post({ prompt: 'a cat surfing' })); // upstream_error
    for (const r of responses) {
      const body = await r.json();
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    }
  });

  it('keeps an ambiguous submit failure pending for the sweeper instead of refunding', async () => {
    state.submitError = new Error('ETIMEDOUT');
    const res = await post({ prompt: 'a cat surfing' });
    expect(res.status).toBe(202);
    expect(state.refunds).toHaveLength(0);
    // Row exists, charge exists, no task id — exactly what the cron sweeper
    // needs to close this out after its grace window.
    expect(state.jobs[0].providerTaskId).toBe('');
    expect(state.jobs[0].status).toBe('pending');
    expect(state.ledger).toHaveLength(1);
  });

  it('only sends webhook_config when a real secret and https origin exist', async () => {
    await post({ prompt: 'a cat surfing' });
    expect(state.submits[0].webhookConfig).toBeUndefined();

    process.env.PIAPI_WEBHOOK_SECRET = 'x'.repeat(32);
    process.env.NEXT_PUBLIC_APP_URL = 'https://sociafy.test';
    await post({ prompt: 'a cat surfing' });
    expect(state.submits[1].webhookConfig).toEqual({
      endpoint: 'https://sociafy.test/api/piapi/webhook',
      secret: 'x'.repeat(32),
    });
  });
});

describe('GET /api/v1/videos/{id}', () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it('returns another tenant\'s job as 404, not 403', async () => {
    const created = await (await post({ prompt: 'a cat surfing' })).json();

    state.userId = 'user_2';
    const res = await GET(new Request('https://sociafy.test/x') as never, params(created.id));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
  });

  it('returns the job for its owner', async () => {
    const created = await (await post({ prompt: 'a cat surfing' })).json();
    const res = await GET(new Request('https://sociafy.test/x') as never, params(created.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: created.id, status: 'pending', video_url: null, credits_charged: 180 });
  });

  it('404s a non-uuid id without touching the db', async () => {
    const res = await GET(new Request('https://sociafy.test/x') as never, params('../../etc/passwd'));
    expect(res.status).toBe(404);
  });

  // U3: `[0-9a-f-]{36}` admitted these, then Postgres' uuid cast threw inside the
  // query and withApiKey rendered 500 internal for what is only a miss.
  it('404s a 36-char string that is not a valid uuid, not 500', async () => {
    for (const bad of [
      '----------------------------------aa',
      '0000000000000000-0000-4000-8000-0000',
      'gggggggg-0000-4000-8000-000000000001'.slice(0, 36),
      '00000000-0000-4000-8000-00000000000',   // 35 chars
    ]) {
      const res = await GET(new Request('https://sociafy.test/x') as never, params(bad));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('not_found');
      expect(typeof body.message).toBe('string');
    }
  });
});
