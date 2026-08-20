import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Money-critical invariants of the public v1 API:
 *   - the same Idempotency-Key charges ONCE and returns the SAME job
 *   - every charge carries meta.apiKeyId (the auth layer's spend cap reads it;
 *     omit it and the cap silently stops working)
 *   - reference stills are re-hosted before the provider ever sees a caller URL,
 *     and reference *video* stays rejected (it is unpriceable today)
 *   - a provider content refusal reads as prompt_rejected, not generation_failed
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
  /** Reference stills we re-hosted, and the URLs we fetched to get them.
   *  Stands in for the whole internet — no test makes a real request. */
  uploads: [] as string[],
  fetched: [] as string[],
  refFetch: null as ((url: URL) => Response) | null,
  uploadFails: false,
  /** Overrides what finalizeVideoJob answers, so the reader's own handling of a
   *  completion it cannot resolve is testable without racing anything. */
  finalizeResult: null as Record<string, unknown> | null,
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
  finalizeVideoJob: (job: Record<string, unknown>) =>
    Promise.resolve(state.finalizeResult ?? { status: job.status ?? 'pending' }),
}));

vi.mock('../../../lib/storage/r2', () => ({
  makeMediaKey: (u: string, n: string) => `users/${u}/${n}`,
  publicUrlFor: (k: string) => `https://cdn.test/${k}`,
  uploadBuffer: (a: { key: string }) => {
    if (state.uploadFails) return Promise.reject(new Error('r2 down'));
    state.uploads.push(a.key);
    return Promise.resolve();
  },
}));

/** Minimal real PNG — fetchReferenceImages verifies magic bytes, not pixels. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(25),
]);
/** Public literal IPs, so isPublicHost answers without touching DNS. */
const REF_A = 'https://93.184.216.34/rings/front.png';
const REF_B = 'https://93.184.216.34/rings/side.png';

vi.stubGlobal('fetch', (input: URL | string) => {
  const url = new URL(String(input));
  state.fetched.push(url.toString());
  return Promise.resolve(
    state.refFetch?.(url) ??
      new Response(PNG as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } }),
  );
});

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
  state.finalizeResult = null;
  state.failUpdates = false;
  state.uploads = [];
  state.fetched = [];
  state.refFetch = null;
  state.uploadFails = false;
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

  // Reference VIDEO is the withheld mode — it carries the input-duration
  // surcharge. An unknown field is how it stays out.
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

  it('records the job id on the refund so a charge and its reversal reconcile', async () => {
    state.submitError = new Error('piapi_400: {"message":"bad prompt"}');
    await post({ prompt: 'a cat surfing' });
    expect(state.refunds).toHaveLength(1);
    expect((state.refunds[0] as { meta: { videoJobId: string } }).meta.videoJobId).toBe(state.jobs[0].id);
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

/**
 * Still-image inputs. Two things are load-bearing: the provider gets OUR urls
 * and never the caller's, and a contradictory body is refused rather than
 * resolved by precedence — silently preferring one field spends credits on a
 * request nobody made.
 */
describe('POST /api/v1/videos — reference stills', () => {
  it('submits omni_reference with re-hosted urls, at the text-mode price', async () => {
    const res = await post({
      prompt: 'this exact ring rotating on white marble',
      gen_mode: 'reference',
      reference_images: [REF_A, REF_B],
    });
    expect(res.status).toBe(202);
    expect((await res.json()).credits_charged).toBe(180); // identical to text-only

    expect(state.fetched).toEqual([REF_A, REF_B]);
    expect(state.uploads).toHaveLength(2);
    const submit = state.submits[0] as { mode: string; imageUrls: string[] };
    expect(submit.mode).toBe('omni_reference');
    expect(submit.imageUrls).toHaveLength(2);
    // The caller's host must not reach the provider.
    for (const u of submit.imageUrls) expect(u.startsWith('https://cdn.test/users/user_1/')).toBe(true);
    expect(JSON.stringify(submit.imageUrls)).not.toContain('93.184.216.34');
  });

  it('submits first_last_frames as [start, end] in that order', async () => {
    await post({ prompt: 'the ring, slowly rotating', gen_mode: 'image-to-video', start_frame: REF_A, end_frame: REF_B });
    const submit = state.submits[0] as { mode: string; imageUrls: string[] };
    expect(submit.mode).toBe('first_last_frames');
    expect(state.fetched).toEqual([REF_A, REF_B]);
    expect(submit.imageUrls).toHaveLength(2);
    expect(submit.imageUrls[0]).toContain('reference-1.png');
    expect(submit.imageUrls[1]).toContain('reference-2.png');
  });

  it('accepts image-to-video with only a start frame', async () => {
    await post({ prompt: 'the ring, slowly rotating', gen_mode: 'image-to-video', start_frame: REF_A });
    expect((state.submits[0] as { imageUrls: string[] }).imageUrls).toHaveLength(1);
  });

  it('records the mode and the reference count on the charge', async () => {
    await post({ prompt: 'this exact ring', gen_mode: 'reference', reference_images: [REF_A] });
    const meta = (state.charges[0] as { meta: Record<string, unknown> }).meta;
    expect(meta.genMode).toBe('reference');
    expect(meta.referenceImages).toBe(1);
  });

  it('leaves text-only submission untouched', async () => {
    await post({ prompt: 'a cat surfing' });
    const submit = state.submits[0] as { mode: string; imageUrls?: string[] };
    expect(submit.mode).toBe('text_to_video');
    expect(submit.imageUrls).toBeUndefined();
    expect(state.fetched).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
  });

  it('400s every contradictory combination, fetching and charging nothing', async () => {
    const bodies = [
      { gen_mode: 'reference' },                                        // no stills
      { gen_mode: 'image-to-video' },                                   // no start frame
      { gen_mode: 'text', reference_images: [REF_A] },                  // stills without the mode
      { gen_mode: 'text', start_frame: REF_A },                         // frame without the mode
      { gen_mode: 'reference', reference_images: [REF_A], start_frame: REF_B },
      { gen_mode: 'image-to-video', start_frame: REF_A, reference_images: [REF_B] },
      // 10 stills — one past Seedance's own hard limit. Not our choice: PiAPI
      // answers `400 omni_reference mode accepts at most 9 reference images`,
      // so rejecting here saves a charge that would only be refunded later.
      { gen_mode: 'reference', reference_images: Array.from({ length: 10 }, () => REF_A) },
      { gen_mode: 'video-reference', start_frame: REF_A },              // the withheld mode
    ];
    for (const b of bodies) {
      const res = await post({ prompt: 'a cat surfing', ...b });
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((await res.json()).error).toBe('invalid_request');
    }
    expect(state.charges).toHaveLength(0);
    expect(state.fetched).toHaveLength(0);
  });

  it('rejects a bad reference url with its own code, before charging', async () => {
    const res = await post({ prompt: 'x'.repeat(10), gen_mode: 'reference', reference_images: ['http://cdn.test/a.png'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('reference_url_rejected');
    expect(state.charges).toHaveLength(0);
    expect(state.submits).toHaveLength(0);
  });

  it('does not charge when a reference cannot be stored on our side', async () => {
    state.uploadFails = true;
    const res = await post({ prompt: 'x'.repeat(10), gen_mode: 'reference', reference_images: [REF_A] });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('service_unavailable');
    expect(state.charges).toHaveLength(0);
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

  it('serves a completed job with the stored url', async () => {
    const created = await (await post({ prompt: 'a cat surfing' })).json();
    state.finalizeResult = { status: 'completed', asset: { publicUrl: 'https://cdn.test/users/user_1/vid.mp4' } };
    const body = await (await GET(new Request('https://sociafy.test/x') as never, params(created.id))).json();
    expect(body).toMatchObject({ status: 'completed', video_url: 'https://cdn.test/users/user_1/vid.mp4', error: null });
  });

  // A `completed` with a null url is what made an integrator discard an asset
  // they had paid for. Not deliverable yet = pending, so the poll loop continues.
  it('reports a completion it cannot resolve a url for as pending', async () => {
    const created = await (await post({ prompt: 'a cat surfing' })).json();
    state.finalizeResult = { status: 'completed' };
    const body = await (await GET(new Request('https://sociafy.test/x') as never, params(created.id))).json();
    expect(body).toMatchObject({ status: 'pending', video_url: null, error: null });
  });

  it('still terminates a genuine failure with its public code', async () => {
    const created = await (await post({ prompt: 'a cat surfing' })).json();
    state.finalizeResult = { status: 'failed', error: 'submit_failed: piapi_400 {"detail":"nope"}' };
    const body = await (await GET(new Request('https://sociafy.test/x') as never, params(created.id))).json();
    expect(body).toMatchObject({ status: 'failed', error: 'generation_rejected', video_url: null });
    expect(JSON.stringify(body)).not.toMatch(/piapi|nope/i);
  });

  // Production: two 90-credit jobs failed with "piapi_failed: Your content
  // violated community guidelines" and both reported generation_failed, so the
  // customer could not tell "change your prompt" from "their infrastructure
  // broke". Moderation is the caller's input and gets the image endpoint's code.
  it('maps a provider content refusal to prompt_rejected, neutrally', async () => {
    const created = await (await post({ prompt: 'a cat surfing' })).json();
    for (const raw of [
      'piapi_failed: Your content violated community guidelines.',
      'piapi_failed: request blocked by content policy',
      'piapi_failed: NSFW content detected',
    ]) {
      state.finalizeResult = { status: 'failed', error: raw };
      const res = await GET(new Request('https://sociafy.test/x') as never, params(created.id));
      const body = await res.json();
      expect(body.error, raw).toBe('prompt_rejected');
      expect(JSON.stringify(body)).not.toMatch(/piapi|seedance|community guidelines|nsfw/i);
    }
  });

  it('keeps other provider failures as generation_failed', async () => {
    const created = await (await post({ prompt: 'a cat surfing' })).json();
    for (const raw of [
      'piapi_failed: internal server error',
      'piapi_failed: gpu allocation timeout',
      'piapi_failed: unknown',
    ]) {
      state.finalizeResult = { status: 'failed', error: raw };
      const body = await (await GET(new Request('https://sociafy.test/x') as never, params(created.id))).json();
      expect(body.error, raw).toBe('generation_failed');
    }
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
