import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The dashboard image route had no reference support at all while /api/v1/images
 * did, so a customer generating their own product could only do it through the
 * API. Parity means the same fetcher (the SSRF trust boundary), the same flat
 * per-reference price, and the same images.edit call — never a second copy of
 * any of them.
 */

const state = vi.hoisted(() => ({
  charges: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  generateCalls: [] as Record<string, unknown>[],
  editCalls: [] as Record<string, unknown>[],
  fetched: [] as string[],
  uploads: 0,
  genError: null as (Error & { status?: number }) | null,
}));

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));

vi.mock('../../../../lib/db', () => ({
  db: () => ({
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => Promise.resolve([{ id: 'asset_1', ...v }]),
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  }),
}));
vi.mock('drizzle-orm', () => ({
  eq: (_c: unknown, v: unknown) => v,
  ne: () => true,
  and: (...cs: unknown[]) => cs,
  notInArray: () => true,
  sql: () => ({}),
}));
vi.mock('../../../../lib/db/schema', () => ({
  mediaAssets: { id: 'id' }, videoJobs: { id: 'id' }, genJobs: { id: 'id' }, creditLedger: { id: 'id' },
}));
vi.mock('../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('../../../../lib/env', () => ({ isStubMode: { r2: () => false, database: () => false } }));
vi.mock('../../../../lib/ai/prompt-rewriter', () => ({
  rewritePromptForMedia: ({ userPrompt }: { userPrompt: string }) =>
    Promise.resolve({ prompt: `${userPrompt} (rewritten)`, enhanced: true }),
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
vi.mock('../../../../lib/storage/r2', () => ({
  makeMediaKey: (u: string, n: string) => `users/${u}/${n}`,
  publicUrlFor: (k: string) => `https://cdn.test/${k}`,
  uploadBuffer: () => { state.uploads++; return Promise.resolve(); },
}));
vi.mock('../../../../lib/credits/ledger', () => ({
  ensureBalance: () => Promise.resolve({ ok: true, balance: 10_000 }),
  charge: (a: Record<string, unknown>) => {
    state.charges.push(a);
    return Promise.resolve({ ledgerId: 'led_1', balanceAfter: 9_000 });
  },
  refund: (a: Record<string, unknown>) => { state.refunds.push(a); return Promise.resolve({ refunded: true }); },
  partialRefund: () => Promise.resolve({ balanceAfter: 9_500 }),
  insufficientCreditsResponse: () => ({ error: 'insufficient_credits', status: 402 }),
}));
vi.mock('../../../../lib/ai/client', () => {
  const answer = () => {
    if (state.genError) return Promise.reject(state.genError);
    return Promise.resolve({ data: [{ b64_json: Buffer.from('png').toString('base64') }] });
  };
  return {
    MODELS: { image: 'gpt-image-test' },
    getOpenAI: () => ({
      images: {
        generate: (a: Record<string, unknown>) => { state.generateCalls.push(a); return answer(); },
        edit: (a: Record<string, unknown>) => { state.editCalls.push(a); return answer(); },
      },
    }),
  };
});

import { POST } from './route';

/** Minimal real PNG — fetchReferenceImages checks the magic bytes against the
 *  declared content-type, so a fake body is rejected on purpose. */
function png(): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(1024, 16);
  b.writeUInt32BE(1024, 20);
  return b;
}

/** A public literal IP, so the host check answers without touching DNS. */
const REF_URL = 'https://93.184.216.34/rings/ref-1.png';

vi.stubGlobal('fetch', (input: URL | string) => {
  state.fetched.push(String(input));
  return Promise.resolve(new Response(new Uint8Array(png()), { status: 200, headers: { 'content-type': 'image/png' } }));
});

function call(body: Record<string, unknown>) {
  return POST({ json: async () => body } as never) as unknown as Promise<Response & Record<string, unknown>>;
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key';
  state.charges = []; state.refunds = []; state.generateCalls = []; state.editCalls = [];
  state.fetched = []; state.uploads = 0; state.genError = null;
});

describe('POST /api/media/generate-image — reference images', () => {
  it('is byte-identical without references: images.generate, base price, no fetch', async () => {
    const res = await call({ prompt: 'a red bicycle', count: 2 });
    expect(state.editCalls).toHaveLength(0);
    expect(state.generateCalls).toHaveLength(2);
    expect(state.fetched).toHaveLength(0);
    // medium / square = 6 credits each.
    expect((state.charges[0] as { credits: number }).credits).toBe(12);
    expect(res.creditsCharged).toBe(12);
    expect((state.charges[0] as { meta: Record<string, unknown> }).meta.referenceImages).toBeUndefined();
  });

  it('switches to images.edit and charges the flat surcharge per reference', async () => {
    const res = await call({ prompt: 'this exact ring on marble', referenceImageUrls: [REF_URL] });
    expect(state.generateCalls).toHaveLength(0);
    expect(state.editCalls).toHaveLength(1);
    const edit = state.editCalls[0] as { model: string; image: File[]; prompt: string; n: number };
    expect(edit.model).toBe('gpt-image-test');
    expect(edit.image[0]).toBeInstanceOf(File);
    expect(edit.image[0].type).toBe('image/png');
    expect(edit.prompt).toContain('(rewritten)');
    // gpt-image-2 answers 400 invalid_input_fidelity_model on this field.
    expect(Object.keys(edit)).not.toContain('input_fidelity');
    // 6 (medium square) + 6 (one reference, flat) = 12.
    expect((state.charges[0] as { credits: number }).credits).toBe(12);
    expect(res.creditsCharged).toBe(12);
    const meta = (state.charges[0] as { meta: Record<string, unknown> }).meta;
    expect(meta.referenceImages).toBe(1);
    expect(meta.referenceSurcharge).toBe(6);
  });

  it('charges the surcharge per generated image, like the base price', async () => {
    await call({ prompt: 'this exact ring', count: 2, referenceImageUrls: [REF_URL, REF_URL] });
    expect((state.charges[0] as { credits: number }).credits).toBe((6 + 12) * 2);
    expect((state.editCalls[0] as { image: File[] }).image).toHaveLength(2);
  });

  it('rejects a reference we must not fetch, before any charge', async () => {
    for (const url of ['http://93.184.216.34/ref.png', 'https://127.0.0.1/ref.png', 'https://169.254.169.254/ref.png']) {
      state.charges = []; state.editCalls = []; state.generateCalls = []; state.uploads = 0;
      const res = await call({ prompt: 'a ring', referenceImageUrls: [url] });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('reference_url_rejected');
      expect(state.charges).toHaveLength(0);
      expect(state.editCalls).toHaveLength(0);
      expect(state.generateCalls).toHaveLength(0);
      expect(state.uploads).toBe(0);
    }
  });

  it('refunds the surcharge too when the reference generation fails', async () => {
    state.genError = Object.assign(new Error('400 rejected'), {
      status: 400, code: 'moderation_blocked', error: { code: 'moderation_blocked' },
    });
    const res = await call({ prompt: 'a ring', referenceImageUrls: [REF_URL] });
    expect(res.error).toBe('prompt_rejected');
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0].ledgerId).toBe('led_1');
  });
});
