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
            const merge = (v.meta as { __merge?: Record<string, unknown> } | undefined)?.__merge;
            Object.assign(r, merge ? { meta: { ...(r.meta as object), ...merge } } : v);
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
    return Promise.resolve({ refunded: true, balanceAfter: 1_000 });
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
  process.env.OPENAI_API_KEY = 'test-key';
});

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

  it('refunds and reports a content-filter rejection as the caller\'s 400', async () => {
    state.genError = Object.assign(new Error('moderation_blocked: prompt rejected'), { status: 400 });
    const res = await post({ prompt: 'a red bicycle' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('prompt_rejected');
    expect(state.refunds).toHaveLength(1);
  });

  it('refunds and returns a neutral 502 on an upstream failure', async () => {
    state.genError = Object.assign(new Error('openai_500: internal'), { status: 500 });
    const res = await post({ prompt: 'a red bicycle' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('upstream_error');
    expect(JSON.stringify(body)).not.toMatch(/openai/i);
    expect(state.refunds).toHaveLength(1);
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
    state.ledger.push({ id: 'ledger_1', userId: 'user_1', kind: 'charge', credits: -6, meta: { source: 'api:img-key-0002' } });
    const res = await post({ prompt: 'a red bicycle' }, 'img-key-0002');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('request_in_progress');
    expect(state.charges).toHaveLength(0);
  });
});
