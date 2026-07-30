import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Images are OpenAI-backed, not the video provider — but the money contract is
 * identical: charge before generating, refund anything we don't deliver, and
 * never charge twice for one Idempotency-Key.
 */

const col = (name: string) => ({ __name: name });

const state = vi.hoisted(() => ({
  ledger: [] as Record<string, unknown>[],
  assets: [] as Record<string, unknown>[],
  charges: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  uploads: 0,
  genError: null as (Error & { status?: number }) | null,
  /** Lets a test simulate a refund that did NOT land, which must keep the
   *  idempotency claim rather than free it for a second charge. */
  refundLands: true,
}));

vi.mock('../../../lib/api-key', () => ({
  withApiKey: (_req: unknown, handler: (a: { userId: string; apiKeyId: string }) => unknown) =>
    Promise.resolve(handler({ userId: 'user_1', apiKeyId: 'key_1' })),
}));

vi.mock('../../../lib/db/schema', () => ({
  videoJobs: { __t: 'jobs', id: col('id'), userId: col('userId') },
  creditLedger: {
    __t: 'ledger',
    id: col('id'), userId: col('userId'), kind: col('kind'), credits: col('credits'), meta: col('meta'),
    createdAt: col('createdAt'),
  },
  mediaAssets: { __t: 'assets', id: col('id'), userId: col('userId'), publicUrl: col('publicUrl') },
  apiKeys: { __t: 'keys', id: col('id') },
}));

vi.mock('drizzle-orm', () => ({
  eq: (c: { __name: string }, v: unknown) => (r: Record<string, unknown>) => r[c.__name] === v,
  and: (...ps: unknown[]) => (r: Record<string, unknown>) =>
    ps.every((p) => (typeof p === 'function' ? (p as (x: unknown) => boolean)(r) : true)),
  gte: () => () => true,
  sql: (strings: string[], ...vals: unknown[]) => {
    const text = strings.join('?');
    // releaseIdempotencySource's `meta - 'source'`. Checked before the generic
    // `||` branch because that statement contains one too.
    if (text.includes("- 'source'")) return { __releaseSource: true };
    // patchChargeMeta's jsonb merge — surface it so the fake can apply it.
    if (text.includes('||')) return { __merge: JSON.parse(String(vals[1])) };
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
const storeFor = (t: { __t?: string }) => (t.__t === 'ledger' ? state.ledger : state.assets);

vi.mock('../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: (t: { __t?: string }) => ({
        where: (pred: Pred) => ({ limit: () => Promise.resolve(storeFor(t).filter((r) => pred(r))) }),
      }),
    }),
    insert: (t: { __t?: string }) => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          const store = storeFor(t);
          const row = { id: `${t.__t}_${store.length + 1}`, ...v };
          store.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
    update: (t: { __t?: string }) => ({
      set: (v: Record<string, unknown>) => ({
        where: (pred: Pred) => {
          for (const r of storeFor(t).filter((x) => pred(x))) {
            const op = v.meta as
              | { __merge?: Record<string, unknown>; __releaseSource?: boolean }
              | undefined;
            if (op?.__releaseSource) {
              // Models the real statement: source moves aside, so the partial
              // unique index no longer matches this row.
              const meta = { ...(r.meta as Record<string, unknown>) };
              meta.releasedSource = meta.source;
              delete meta.source;
              Object.assign(r, { meta });
            } else {
              Object.assign(r, op?.__merge ? { meta: { ...(r.meta as object), ...op.__merge } } : v);
            }
          }
          return {
            returning: () => Promise.resolve([]),
            then: (r: (x: unknown) => unknown) => Promise.resolve(undefined).then(r),
          };
        },
      }),
    }),
  }),
}));

vi.mock('../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true, remaining: 9, retryAfterSec: 0 }) }));
vi.mock('../../../lib/env', () => ({ isStubMode: { r2: () => false, database: () => false } }));

class InsufficientCreditsError extends Error {}

vi.mock('../../../lib/credits/ledger', () => ({
  InsufficientCreditsError,
  getBalance: () => Promise.resolve(1_000),
  refund: (a: Record<string, unknown>) => {
    state.refunds.push(a);
    return Promise.resolve({ refunded: state.refundLands, balanceAfter: 1_000 });
  },
  charge: (a: { userId: string; credits: number; meta?: Record<string, unknown> }) => {
    state.charges.push(a as Record<string, unknown>);
    const source = a.meta?.source;
    if (source && state.ledger.some((r) => (r.meta as { source?: unknown })?.source === source)) {
      const e = new Error('duplicate key value violates unique constraint');
      (e as unknown as { code: string }).code = '23505';
      return Promise.reject(e);
    }
    const row = { id: `ledger_${state.ledger.length + 1}`, userId: a.userId, kind: 'charge', credits: -a.credits, meta: a.meta ?? {} };
    state.ledger.push(row);
    return Promise.resolve({ ledgerId: row.id, balanceAfter: 1_000 });
  },
}));

vi.mock('../../../lib/storage/r2', () => ({
  makeMediaKey: (u: string, n: string) => `users/${u}/${n}`,
  publicUrlFor: (k: string) => `https://cdn.test/${k}`,
  uploadBuffer: () => {
    state.uploads++;
    return Promise.resolve();
  },
}));

vi.mock('../../../lib/ai/client', () => ({
  MODELS: { image: 'gpt-image-test' },
  getOpenAI: () => ({
    images: {
      generate: () => {
        if (state.genError) return Promise.reject(state.genError);
        return Promise.resolve({ data: [{ b64_json: Buffer.from('png').toString('base64') }] });
      },
    },
  }),
}));

const { POST } = await import('./images/route');

function post(body: unknown, idempotencyKey?: string) {
  return POST(
    new Request('https://sociafy.test/api/v1/images', {
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
  state.ledger = [];
  state.assets = [];
  state.charges = [];
  state.refunds = [];
  state.uploads = 0;
  state.genError = null;
  state.refundLands = true;
  process.env.OPENAI_API_KEY = 'test-key';
});

/** Shapes an error the way the OpenAI SDK's APIError does (see
 *  node_modules/openai/core/error.js: status + code/type/message lifted off the
 *  response body's `error` object). */
const apiErr = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(`${status} ${body.message ?? ''}`), {
    status,
    code: body.code,
    type: body.type,
    error: body,
  }) as Error & { status?: number };

describe('POST /api/v1/images', () => {
  it('charges with meta.apiKeyId and returns an R2 url', async () => {
    const res = await post({ prompt: 'a red bicycle', quality: 'medium' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credits_charged).toBe(6); // medium / square
    expect(body.image_url).toMatch(/^https:\/\/cdn\.test\/users\/user_1\//);
    expect((state.charges[0] as { meta: Record<string, unknown> }).meta.apiKeyId).toBe('key_1');
    expect(state.uploads).toBe(1);
  });

  it('refunds and reports a real content-filter rejection as the caller\'s 400', async () => {
    state.genError = apiErr(400, { code: 'moderation_blocked', message: 'Your request was rejected.' });
    const res = await post({ prompt: 'a red bicycle' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('prompt_rejected');
    expect(state.refunds).toHaveLength(1);
  });

  it('reports a code-less safety refusal as prompt_rejected via its message', async () => {
    state.genError = apiErr(400, {
      type: 'invalid_request_error',
      message: 'Your request was rejected as a result of our safety system.',
    });
    expect((await (await post({ prompt: 'a red bicycle' })).json()).error).toBe('prompt_rejected');
  });

  // The bug that made EVERY images call return prompt_rejected, including on the
  // docs' own example prompt: any provider 400 was blamed on the content filter,
  // so a misconfigured model looked like the caller writing something obscene.
  it('does NOT report a provider configuration 400 as prompt_rejected', async () => {
    state.genError = apiErr(400, {
      code: 'unknown_parameter',
      type: 'invalid_request_error',
      message: "Unknown parameter: 'quality'.",
    });
    const res = await post({ prompt: 'a matcha latte on an oak table' });
    const body = await res.json();
    expect(body.error).not.toBe('prompt_rejected');
    expect(body.error).toBe('configuration_error');
    expect(res.status).toBe(502);
    // Honest about whose fault it is, and no provider detail leaks.
    expect(body.message).toMatch(/our side/i);
    expect(JSON.stringify(body)).not.toMatch(/openai|quality'|unknown_parameter/i);
    expect(state.refunds).toHaveLength(1);
  });

  it('does NOT report an unknown model as prompt_rejected', async () => {
    state.genError = apiErr(404, { code: 'model_not_found', message: 'The model does not exist.' });
    const res = await post({ prompt: 'a red bicycle' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('configuration_error');
  });

  it('reports an account/access failure as 503, not the caller\'s fault', async () => {
    state.genError = apiErr(403, { code: 'unsupported_model', message: 'Your organization must be verified.' });
    const res = await post({ prompt: 'a red bicycle' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('service_unavailable');
    expect(state.refunds).toHaveLength(1);
  });

  it('refunds and returns a neutral 502 on an upstream failure', async () => {
    state.genError = apiErr(500, { message: 'internal error' });
    const res = await post({ prompt: 'a red bicycle' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('upstream_error');
    expect(JSON.stringify(body)).not.toMatch(/openai/i);
    expect(state.refunds).toHaveLength(1);
  });

  it('carries a human message on every error response', async () => {
    const cases: Array<Promise<Response>> = [
      post({ prompt: 'x' }),                              // invalid_request
      post({ prompt: 'a red bicycle' }, 'bad key'),       // invalid_idempotency_key (space)
    ];
    for (const p of cases) {
      const body = await (await p).json();
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    }
  });

  it('charges once and returns the same asset for a repeated Idempotency-Key', async () => {
    const a = await (await post({ prompt: 'a red bicycle' }, 'img-key-0001')).json();
    const second = await post({ prompt: 'a red bicycle' }, 'img-key-0001');
    const b = await second.json();

    expect(b.id).toBe(a.id);
    expect(b.image_url).toBe(a.image_url);
    expect(second.headers.get('idempotency-replay')).toBe('true');
    expect(state.ledger).toHaveLength(1);
    expect(state.uploads).toBe(1);
    expect(state.refunds).toHaveLength(0);
  });

  it('409s a replay whose original is still in flight', async () => {
    // A charge row exists for the key but its asset was never recorded — the
    // in-flight twin owns it. Neither a second charge nor a fake success.
    state.ledger.push({ id: 'ledger_1', userId: 'user_1', kind: 'charge', credits: -6, meta: { source: 'api:images:img-key-0002' } });
    const res = await post({ prompt: 'a red bicycle' }, 'img-key-0002');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('request_in_progress');
    expect(state.charges).toHaveLength(0);
  });

  // W4: the refund leaves the charge row in place, so the row kept matching the
  // idempotency index and every retry 409'd forever — while the docs told the
  // developer to retry the same key.
  it('frees a failed attempt\'s Idempotency-Key so an honest retry works', async () => {
    state.genError = apiErr(500, { message: 'internal error' });
    expect((await post({ prompt: 'a red bicycle' }, 'img-retry-0001')).status).toBe(502);
    expect(state.refunds).toHaveLength(1);

    // Same key, provider now healthy: a real generation, not a permanent 409.
    state.genError = null;
    const retry = await post({ prompt: 'a red bicycle' }, 'img-retry-0001');
    expect(retry.status).toBe(200);
    expect((await retry.json()).image_url).toMatch(/^https:\/\/cdn\.test\//);
    expect(state.uploads).toBe(1);
  });

  it('keeps the key claimed when the refund did not land, rather than risk a double charge', async () => {
    state.genError = apiErr(500, { message: 'internal error' });
    state.refundLands = false;
    expect((await post({ prompt: 'a red bicycle' }, 'img-retry-0002')).status).toBe(502);

    state.genError = null;
    const retry = await post({ prompt: 'a red bicycle' }, 'img-retry-0002');
    expect(retry.status).toBe(409);
    expect(state.charges).toHaveLength(1); // the failed one only
  });

  it('keeps a successful attempt idempotent — the key is not released', async () => {
    const first = await (await post({ prompt: 'a red bicycle' }, 'img-keep-0001')).json();
    const second = await post({ prompt: 'a totally different prompt' }, 'img-keep-0001');
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotency-replay')).toBe('true');
    expect((await second.json()).id).toBe(first.id);
    expect(state.ledger).toHaveLength(1);
    expect(state.uploads).toBe(1);
  });

  it('sends Idempotency-Replay on the fresh path too, not only on a replay', async () => {
    const res = await post({ prompt: 'a red bicycle' }, 'img-hdr-0001');
    expect(res.headers.get('idempotency-replay')).toBe('false');
  });

  // Scoping the source per endpoint is what stops one raw key reused on both
  // POSTs from colliding on the shared unique index.
  it('scopes the idempotency source to the endpoint', async () => {
    await post({ prompt: 'a red bicycle' }, 'shared-key-0001');
    expect((state.charges[0] as { meta: { source: string } }).meta.source).toBe('api:images:shared-key-0001');
  });
});
