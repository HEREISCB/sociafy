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
  /** Provider calls, split by mechanism: reference input must go to images.edit
   *  and text-only must stay on images.generate. */
  generateCalls: [] as Record<string, unknown>[],
  editCalls: [] as Record<string, unknown>[],
  /** Stands in for the whole internet. No test makes a real request. */
  refFetch: null as ((url: URL) => Response) | null,
  fetched: [] as string[],
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
  ensureBalance: () => Promise.resolve({ ok: true, balance: 1_000 }),
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

vi.mock('../../../lib/ai/client', () => {
  const answer = () => {
    if (state.genError) return Promise.reject(state.genError);
    return Promise.resolve({ data: [{ b64_json: Buffer.from('png').toString('base64') }] });
  };
  return {
    MODELS: { image: 'gpt-image-test' },
    getOpenAI: () => ({
      images: {
        generate: (a: Record<string, unknown>) => {
          state.generateCalls.push(a);
          return answer();
        },
        edit: (a: Record<string, unknown>) => {
          state.editCalls.push(a);
          return answer();
        },
      },
    }),
  };
});

const { POST } = await import('./images/route');

// ---- reference-image fixtures ----------------------------------------------

/** Minimal but real PNG header — imageDimensions parses IHDR, nothing else. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const imageResponse = (body: Buffer | ReadableStream, type = 'image/png') =>
  new Response(body as BodyInit, { status: 200, headers: { 'content-type': type } });

/** A public literal IP, so isPublicHost answers without touching DNS. */
const REF_URL = 'https://93.184.216.34/rings/ref-1.png';

vi.stubGlobal('fetch', (input: URL | string) => {
  const url = new URL(String(input));
  state.fetched.push(url.toString());
  const res = state.refFetch?.(url) ?? imageResponse(png(1024, 1024));
  return Promise.resolve(res);
});

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
  state.generateCalls = [];
  state.editCalls = [];
  state.refFetch = null;
  state.fetched = [];
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

/**
 * Reference input. Two things are being protected here: the trust boundary (we
 * fetch URLs a stranger chose, on a public money-spending endpoint) and the
 * bill (pixels are priced, so an unreadable header must refuse, never guess).
 * Every rejection has to happen before the ledger is touched.
 */
describe('POST /api/v1/images — reference_images', () => {
  const ref = (body: unknown = {}) => ({
    prompt: 'this exact ring, on white marble, soft studio light',
    reference_images: [REF_URL],
    ...(body as object),
  });

  /** Asserts a rejection code AND that it was free — no charge, no provider call. */
  async function expectRejected(body: unknown, code: string) {
    const res = await post(body);
    const json = await res.json();
    expect([res.status, json.error]).toEqual([400, code]);
    expect(typeof json.message).toBe('string');
    expect(json.message.length).toBeGreaterThan(10);
    expect(state.charges).toHaveLength(0);
    expect(state.editCalls).toHaveLength(0);
    expect(state.generateCalls).toHaveLength(0);
    expect(state.uploads).toBe(0);
    return json;
  }

  it('calls images.edit with the fetched files and prices the input pixels', async () => {
    const res = await post(ref());
    expect(res.status).toBe(200);
    // 6 (medium square) + ceil(1024×1024 px = 1.048576 MP × 4 cr) = 6 + 5.
    expect((await res.json()).credits_charged).toBe(11);

    expect(state.generateCalls).toHaveLength(0);
    expect(state.editCalls).toHaveLength(1);
    const call = state.editCalls[0] as { model: string; image: File[]; prompt: string; n: number };
    expect(call.model).toBe('gpt-image-test');
    expect(Array.isArray(call.image)).toBe(true);
    expect(call.image[0]).toBeInstanceOf(File);
    expect(call.image[0].type).toBe('image/png');
    expect(call.n).toBe(1);
    // input_fidelity is 400 invalid_input_fidelity_model on gpt-image-2, and
    // background:transparent is unsupported too — neither may be sent.
    expect(Object.keys(call)).not.toContain('input_fidelity');
    expect(Object.keys(call)).not.toContain('background');

    const meta = (state.charges[0] as { meta: Record<string, unknown> }).meta;
    expect(meta.referenceImages).toBe(1);
    expect(meta.referenceSurcharge).toBe(5);
    expect(state.uploads).toBe(1);
  });

  it('leaves text-only generation on images.generate at the unchanged price', async () => {
    const res = await post({ prompt: 'a red bicycle' });
    expect((await res.json()).credits_charged).toBe(6);
    expect(state.editCalls).toHaveLength(0);
    expect(state.generateCalls).toHaveLength(1);
    expect(state.fetched).toHaveLength(0);
  });

  it('accepts several angles and charges for all of their pixels', async () => {
    const urls = [1, 2, 3, 4].map((n) => `https://93.184.216.34/rings/ref-${n}.png`);
    const res = await post(ref({ reference_images: urls }));
    expect(res.status).toBe(200);
    // 4 × 1.048576 MP = 4.194 MP → ceil(16.78) = 17.
    expect((await res.json()).credits_charged).toBe(6 + 17);
    expect((state.editCalls[0] as { image: File[] }).image).toHaveLength(4);
    expect(state.fetched).toHaveLength(4);
  });

  it('rejects a 5th reference, an empty array and a non-array', async () => {
    for (const value of [
      [1, 2, 3, 4, 5].map((n) => `https://93.184.216.34/${n}.png`),
      [],
      REF_URL,
    ]) {
      state.charges = [];
      await expectRejected({ prompt: 'a ring', reference_images: value }, 'invalid_request');
    }
  });

  it('refuses http and every other scheme', async () => {
    for (const url of [
      'http://93.184.216.34/ref.png',
      'file:///etc/passwd',
      'gopher://93.184.216.34/ref.png',
      'not a url at all',
    ]) {
      await expectRejected(ref({ reference_images: [url] }), 'reference_url_rejected');
    }
    expect(state.fetched).toHaveLength(0);
  });

  // The two bypasses in lib/ai/skills/fetch-url.ts: only dotted-quad IPv4 is
  // matched there, so integer form and IPv4-mapped IPv6 walk straight through.
  it('blocks private, loopback and metadata destinations in every notation', async () => {
    for (const host of [
      '127.0.0.1',
      'localhost',
      '10.0.0.5',
      '192.168.1.10',
      '169.254.169.254',        // cloud instance metadata
      '2130706433',             // integer form of 127.0.0.1
      '0x7f000001',             // hex form
      '127.1',                  // shorthand
      '[::1]',
      '[::ffff:169.254.169.254]', // IPv4-mapped metadata
      '[fd00::1]',
    ]) {
      await expectRejected(ref({ reference_images: [`https://${host}/ref.png`] }), 'reference_url_rejected');
    }
    expect(state.fetched).toHaveLength(0);
  });

  it('refuses a redirect instead of following it', async () => {
    // Following would mean re-validating each hop — the exact step URL fetchers
    // skip, which turns one public-looking URL into an internal one.
    state.refFetch = () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } });
    await expectRejected(ref(), 'reference_url_rejected');
  });

  it('reports an unreachable or erroring URL as unfetchable', async () => {
    state.refFetch = () => new Response('nope', { status: 404 });
    await expectRejected(ref(), 'reference_unfetchable');

    state.refFetch = () => { throw new Error('ETIMEDOUT'); };
    await expectRejected(ref(), 'reference_unfetchable');
  });

  it('refuses a content-type we do not accept', async () => {
    state.refFetch = () => imageResponse(png(1024, 1024), 'image/gif');
    await expectRejected(ref(), 'reference_type_unsupported');

    state.refFetch = () => imageResponse(png(1024, 1024), 'text/html; charset=utf-8');
    await expectRejected(ref(), 'reference_type_unsupported');
  });

  it('refuses bytes that disagree with the declared content-type', async () => {
    // content-type is set by the caller's own server — the magic bytes decide.
    state.refFetch = () => imageResponse(Buffer.from('GIF89a' + 'x'.repeat(64)), 'image/png');
    await expectRejected(ref(), 'reference_type_unsupported');

    state.refFetch = () => imageResponse(png(64, 64), 'image/webp');
    await expectRejected(ref(), 'reference_type_unsupported');
  });

  it('enforces the byte cap while streaming, with no content-length to go on', async () => {
    state.refFetch = () =>
      imageResponse(
        new ReadableStream({
          pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, // endless 1MB chunks
        }),
      );
    await expectRejected(ref(), 'reference_too_large');
  });

  it('refuses an image whose dimensions it cannot read, rather than guessing', async () => {
    // Right magic bytes, no parsable IHDR: unpriceable, so it must fail closed.
    state.refFetch = () =>
      imageResponse(Buffer.concat([png(1, 1).subarray(0, 8), Buffer.alloc(64, 7)]));
    await expectRejected(ref(), 'reference_dimensions_unreadable');
  });

  it('refuses more than the total megapixel ceiling, per image and cumulatively', async () => {
    state.refFetch = () => imageResponse(png(5_000, 4_000)); // 20 MP in one file
    await expectRejected(ref(), 'reference_pixels_exceeded');

    state.refFetch = () => imageResponse(png(2_500, 2_000)); // 5 MP each, 20 MP total
    await expectRejected(
      ref({ reference_images: [1, 2, 3, 4].map((n) => `https://93.184.216.34/${n}.png`) }),
      'reference_pixels_exceeded',
    );
  });

  it('gives no bypass to a URL on our own media host', async () => {
    // "We host it" says nothing about its size or its bytes.
    state.refFetch = () => imageResponse(Buffer.from('<svg/>'), 'image/png');
    await expectRejected(ref({ reference_images: ['https://93.184.216.34/users/user_1/ref.png'] }), 'reference_type_unsupported');
  });

  it('refunds a provider failure on the reference path too, surcharge included', async () => {
    state.genError = apiErr(500, { message: 'internal error' });
    const res = await post(ref());
    expect(res.status).toBe(502);
    expect(state.refunds).toHaveLength(1);
    expect((state.charges[0] as { credits: number }).credits).toBe(11);
  });
});
