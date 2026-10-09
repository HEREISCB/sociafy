import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * POST /api/v1/chat/completions. The money contract differs from images/videos
 * only in ORDER: pre-flight, call, then charge actual usage — so a failed call
 * or a rejected body must never reach the ledger at all.
 */

const col = (name: string) => ({ __name: name });

const state = vi.hoisted(() => ({
  ledger: [] as Record<string, unknown>[],
  charges: [] as { credits: number; action: string; meta: Record<string, unknown> }[],
  calls: [] as Record<string, unknown>[],
  balance: 1_000,
  usage: { prompt_tokens: 1500, completion_tokens: 500, total_tokens: 2000 } as Record<string, number> | undefined,
  genError: null as unknown,
  fetched: [] as string[],
}));

// Mirrors withApiKey's contract: no bearer → 401, a thrown
// InsufficientCreditsError → the 402 envelope.
vi.mock('../../../lib/api-key', () => ({
  withApiKey: async (req: Request, handler: (a: { userId: string; apiKeyId: string }) => Promise<Response>) => {
    if (!req.headers.get('authorization')?.startsWith('Bearer sfy_live_')) {
      return Response.json({ error: 'unauthorized', message: 'Send "Authorization: Bearer sfy_live_…".' }, { status: 401 });
    }
    try {
      return await handler({ userId: 'user_1', apiKeyId: 'key_1' });
    } catch (e) {
      const { balance, needed } = e as { balance: number; needed: number };
      if ((e as Error).name === 'InsufficientCreditsError') {
        return Response.json({ error: 'insufficient_credits', message: 'x', balance, needed }, { status: 402 });
      }
      throw e;
    }
  },
}));

vi.mock('../../../lib/db/schema', () => ({
  videoJobs: { __t: 'videojobs' },
  genJobs: { __t: 'genjobs' },
  mediaAssets: { __t: 'assets' },
  creditLedger: { __t: 'ledger', id: col('id'), userId: col('userId'), kind: col('kind'), credits: col('credits'), meta: col('meta') },
}));

vi.mock('drizzle-orm', () => ({
  eq: (c: { __name: string }, v: unknown) => (r: Record<string, unknown>) => r[c.__name] === v,
  and: (...ps: unknown[]) => (r: Record<string, unknown>) =>
    ps.every((p) => (typeof p === 'function' ? (p as (x: unknown) => boolean)(r) : true)),
  ne: () => () => true,
  gt: () => () => true,
  notInArray: () => () => true,
  sql: (strings: string[], ...vals: unknown[]) => {
    const text = strings.join('?');
    if (text.includes("->>'source' = ")) {
      const want = vals[vals.length - 1];
      return (r: Record<string, unknown>) => (r.meta as { source?: unknown } | null)?.source === want;
    }
    return () => true;
  },
}));

vi.mock('../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => ({
          limit: () => Promise.resolve(state.ledger.filter((r) => pred(r))),
        }),
      }),
    }),
  }),
}));

vi.mock('../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true, remaining: 9, retryAfterSec: 0 }) }));
vi.mock('../../../lib/env', () => ({ isStubMode: { r2: () => false, database: () => false } }));
vi.mock('../../../lib/storage/r2', () => ({ makeMediaKey: () => '', publicUrlFor: () => '', uploadBuffer: () => Promise.resolve() }));

vi.mock('../../../lib/credits/ledger', () => {
  class InsufficientCreditsError extends Error {
    constructor(readonly balance: number, readonly needed: number) {
      super('insufficient_credits');
      this.name = 'InsufficientCreditsError';
    }
  }
  return {
    InsufficientCreditsError,
    ensureBalance: (_u: string, needed: number) =>
      Promise.resolve(state.balance >= needed ? { ok: true, balance: state.balance } : { ok: false, balance: state.balance, needed }),
    refund: () => Promise.resolve({ refunded: true, balanceAfter: 0 }),
    charge: (a: { userId: string; credits: number; action: string; meta: Record<string, unknown> }) => {
      state.charges.push(a);
      const source = a.meta?.source;
      if (source && state.ledger.some((r) => (r.meta as { source?: unknown })?.source === source)) {
        return Promise.reject(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }));
      }
      const row = { id: `ledger_${state.ledger.length + 1}`, userId: a.userId, kind: 'charge', credits: -a.credits, meta: a.meta };
      state.ledger.push(row);
      return Promise.resolve({ ledgerId: row.id, balanceAfter: 0 });
    },
  };
});

vi.mock('../../../lib/ai/client', () => ({
  MODELS: { smart: 'gpt-5', fast: 'gpt-5-mini', image: 'gpt-image-test' },
  getOpenAI: () => ({
    chat: {
      completions: {
        create: (params: Record<string, unknown>) => {
          state.calls.push(params);
          if (state.genError) return Promise.reject(state.genError);
          return Promise.resolve({
            id: 'provider-id-must-not-leak',
            model: params.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'Gold hoops, ready for brunch.', refusal: null }, finish_reason: 'stop' }],
            usage: state.usage,
          });
        },
      },
    },
  }),
}));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(25)]);

vi.stubGlobal('fetch', (input: URL | string) => {
  state.fetched.push(String(input));
  return Promise.resolve(new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
});

const { POST } = await import('./chat/completions/route');

function post(body: unknown, opts: { auth?: boolean; idem?: string } = {}) {
  return POST(
    new Request('https://sociafy.test/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.auth === false ? {} : { authorization: 'Bearer sfy_live_test' }),
        ...(opts.idem ? { 'idempotency-key': opts.idem } : {}),
      },
      body: JSON.stringify(body),
    }) as never,
  );
}

const hello = { messages: [{ role: 'system', content: 'You write captions.' }, { role: 'user', content: 'Caption for gold hoops' }] };

beforeEach(() => {
  state.ledger = [];
  state.charges = [];
  state.calls = [];
  state.balance = 1_000;
  state.usage = { prompt_tokens: 1500, completion_tokens: 500, total_tokens: 2000 };
  state.genError = null;
  state.fetched = [];
  process.env.OPENAI_API_KEY = 'test-key';
});

describe('POST /api/v1/chat/completions', () => {
  it('requires an API key', async () => {
    const res = await post(hello, { auth: false });
    expect(res.status).toBe(401);
    expect(state.calls).toHaveLength(0);
    expect(state.charges).toHaveLength(0);
  });

  it.each([
    ['stream: true', { ...hello, stream: true }, 'stream'],
    ['unknown model', { ...hello, model: 'gpt-4o' }, 'model'],
    ['tools', { ...hello, tools: [{ type: 'function' }] }, 'tools'],
    ['no messages', { messages: [] }, 'messages'],
    ['max_tokens over cap', { ...hello, max_tokens: 100_000 }, 'max_tokens'],
    ['too many images', {
      messages: [{ role: 'user', content: Array.from({ length: 5 }, () => ({ type: 'image_url', image_url: { url: 'https://93.184.216.34/a.png' } })) }],
    }, 'messages'],
  ])('rejects %s with an uncharged 400', async (_name, body, field) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
    expect(json.issues.map((i: { field: string }) => i.field)).toContain(field);
    expect(state.calls).toHaveLength(0);
    expect(state.charges).toHaveLength(0);
  });

  it('charges actual usage, with apiKeyId and via in meta, and answers in the OpenAI shape', async () => {
    state.usage = { prompt_tokens: 3000, completion_tokens: 4000, total_tokens: 7000 };
    const res = await post({ ...hello, temperature: 0.7, max_tokens: 6000 });
    expect(res.status).toBe(200);
    const json = await res.json();

    // 3000×$1.25/1M + 4000×$10/1M = $0.04375 → ×112.5 = 4.92 → 5
    expect(state.charges).toHaveLength(1);
    expect(state.charges[0]).toMatchObject({
      credits: 5,
      action: 'text_chat',
      meta: { apiKeyId: 'key_1', via: 'api_v1', model: 'sociafy-chat-1', promptTokens: 3000, completionTokens: 4000 },
    });
    expect(state.charges[0].meta.response).toBeUndefined(); // no key, nothing to replay

    expect(json).toMatchObject({
      object: 'chat.completion',
      model: 'sociafy-chat-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Gold hoops, ready for brunch.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3000, completion_tokens: 4000, total_tokens: 7000 },
      credits_charged: 5,
    });
    expect(JSON.stringify(json)).not.toMatch(/gpt|provider-id/);

    // Reasoning model: temperature dropped, effort defaulted, max_tokens renamed.
    expect(state.calls[0]).toMatchObject({ model: 'gpt-5', max_completion_tokens: 6000, reasoning_effort: 'minimal' });
    expect(state.calls[0].temperature).toBeUndefined();
  });

  it('bills a small call the 1-credit minimum, and maps the mini model to the fast tier', async () => {
    const res = await post({ ...hello, model: 'sociafy-chat-1-mini' });
    expect(res.status).toBe(200);
    expect(state.calls[0].model).toBe('gpt-5-mini');
    expect(state.charges[0].credits).toBe(1);
  });

  it('passes response_format through', async () => {
    const rf = { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema: { type: 'object' } } };
    await post({ ...hello, response_format: rf });
    expect(state.calls[0].response_format).toEqual(rf);
  });

  it('fetches an https image_url through the hardened fetch and forwards it as a data: URL', async () => {
    const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
    const res = await post({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Which corner is emptiest?' },
          { type: 'image_url', image_url: { url: 'https://93.184.216.34/ring.png', detail: 'high' } },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    });
    expect(res.status).toBe(200);
    expect(state.fetched).toEqual(['https://93.184.216.34/ring.png']);
    const content = (state.calls[0].messages as { content: unknown[] }[])[0].content;
    expect(content).toEqual([
      { type: 'text', text: 'Which corner is emptiest?' },
      { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      { type: 'image_url', image_url: { url: dataUrl } },
    ]);
    expect(state.charges[0].meta.images).toBe(2);
  });

  it.each([
    ['http URL', 'http://93.184.216.34/a.png', 'reference_url_rejected'],
    ['private host', 'https://127.0.0.1/a.png', 'reference_url_rejected'],
    ['data: URL with mismatched bytes', `data:image/jpeg;base64,${PNG.toString('base64')}`, 'reference_type_unsupported'],
    ['data: URL of a non-image type', 'data:text/plain;base64,aGk=', 'reference_type_unsupported'],
  ])('rejects a %s with an uncharged 400', async (_n, url, code) => {
    const res = await post({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(code);
    expect(state.calls).toHaveLength(0);
    expect(state.charges).toHaveLength(0);
  });

  it.each([
    [{ status: 500, message: 'boom' }, 502, 'upstream_error'],
    [{ status: 429, code: 'insufficient_quota' }, 503, 'service_unavailable'],
    [{ status: 429, code: 'rate_limit_exceeded' }, 503, 'service_unavailable'],
    [{ status: 400, code: 'context_length_exceeded', param: 'messages' }, 400, 'invalid_request'],
    [{ status: 400, code: 'content_policy_violation' }, 400, 'prompt_rejected'],
    [{ status: 400, code: 'unknown_parameter', param: 'foo' }, 502, 'configuration_error'],
  ])('a provider failure %o is %i %s and never charged', async (err, status, code) => {
    state.genError = Object.assign(new Error('provider said no'), err);
    const res = await post(hello);
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json.error).toBe(code);
    expect(json.message).not.toMatch(/provider said no|boom/);
    expect(state.charges).toHaveLength(0);
  });

  it('answers 402 before calling the provider when the worst case is unaffordable', async () => {
    state.balance = 0;
    const res = await post(hello);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('insufficient_credits');
    expect(state.calls).toHaveLength(0);
    expect(state.charges).toHaveLength(0);
  });

  it('replays an Idempotency-Key without a second call or charge', async () => {
    const first = await post(hello, { idem: 'caption-order-1' });
    const a = await first.json();
    expect(first.headers.get('idempotency-replay')).toBe('false');
    expect(state.charges[0].meta.source).toBe('api:chat:caption-order-1');

    const second = await post(hello, { idem: 'caption-order-1' });
    expect(second.headers.get('idempotency-replay')).toBe('true');
    expect(await second.json()).toEqual(a);
    expect(state.calls).toHaveLength(1);
    expect(state.charges).toHaveLength(1);
  });

  it('a failed call leaves its Idempotency-Key free for a real retry', async () => {
    state.genError = Object.assign(new Error('x'), { status: 500 });
    expect((await post(hello, { idem: 'retry-me-123' })).status).toBe(502);
    state.genError = null;
    const res = await post(hello, { idem: 'retry-me-123' });
    expect(res.status).toBe(200);
    expect(res.headers.get('idempotency-replay')).toBe('false');
    expect(state.charges).toHaveLength(1);
  });
});
