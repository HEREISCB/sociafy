import { describe, it, expect, beforeEach, vi } from 'vitest';

/** POST /api/media/from-url/videos: plan each product, check the batch against the balance, then render + draft per product. */
const st = vi.hoisted(() => ({
  balance: 100_000,
  // AI motion only → the brain plans a motion graphic every time (deterministic, and the cheapest path to mock).
  av: { motion1: false, cinema: false, templates: false, aiMotion: true } as Record<string, boolean>,
  submits: [] as Record<string, unknown>[],
  drafts: [] as Record<string, unknown>[],
  spread: [] as unknown[][],
  /** Errors to throw, by submit index. */
  failAt: {} as Record<number, Error>,
}));

vi.mock('../../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => Response.json({ error, ...extra }, { status }),
}));
vi.mock('../../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('../../../../../lib/env', () => ({ isStubMode: { r2: () => false } }));
vi.mock('../../../../../lib/ai/client', () => ({ getTextAI: () => null, getGroq: () => null, GROQ_MODELS: {}, completeText: () => Promise.resolve('') }));
vi.mock('../../../../../lib/media/autoVideo', () => ({
  brainContext: () => Promise.resolve({ balance: st.balance, availability: st.av }),
}));
vi.mock('../../../../../lib/media/motionJob', () => ({
  MotionNotReady: class extends Error {},
  submitMotionVideo: () => Promise.reject(new Error('unexpected template')),
  submitMotionAiVideo: (args: Record<string, unknown>) => {
    const n = st.submits.push(args) - 1;
    if (st.failAt[n]) return Promise.reject(st.failAt[n]);
    return Promise.resolve({ job: { id: `job_${n}`, status: 'pending', durationSec: args.durationSec, aspect: args.aspect }, creditsCharged: 216 });
  },
}));
vi.mock('../../../../../lib/media/hybridJob', () => ({ startHybrid: () => Promise.reject(new Error('unexpected hybrid')) }));
vi.mock('../../../../../lib/credits/ledger', () => ({
  InsufficientCreditsError: class extends Error { balance = 0; needed = 1; },
  insufficientCreditsResponse: (a: { balance: number; needed: number }) => Response.json({ error: 'insufficient_credits', ...a }, { status: 402 }),
}));
vi.mock('../../../v1/shared', () => ({
  SubmitFailure: class extends Error { constructor(readonly code: string) { super(code); } },
  submitVideo: () => Promise.reject(new Error('unexpected video')),
  fetchReferenceImages: () => Promise.reject(new Error('unexpected fetch')),
  rehostReferences: () => Promise.reject(new Error('unexpected rehost')),
}));
vi.mock('../../../../../lib/db', () => ({
  db: () => ({
    insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: () => { st.drafts.push(v); return Promise.resolve([{ id: `draft_${st.drafts.length}` }]); } }) }),
  }),
}));
vi.mock('../../../../../lib/agent/plan', () => ({ spreadDrafts: (...a: unknown[]) => { st.spread.push(a); return Promise.resolve({ placed: [], left: 0 }); } }));

import { POST } from './route';
import { MotionNotReady } from '../../../../../lib/media/motionJob';
import { SubmitFailure } from '../../../v1/shared';

const PRODUCTS = [
  { name: 'Cold brew bottle', postText: 'Cold brew in a bottle, ₹199 this week. Order today.', imageUrls: [] },
  { name: 'Pour-over kettle', postText: 'Gooseneck pour-over kettle, ₹1,499. Pour like a barista.', imageUrls: [] },
];
const post = (body: unknown) =>
  POST(new Request('http://x/api/media/from-url/videos', { method: 'POST', body: JSON.stringify(body) }) as never) as unknown as Promise<Response>;

beforeEach(() => {
  st.balance = 100_000; st.submits = []; st.drafts = []; st.spread = []; st.failAt = {};
  st.av = { motion1: false, cinema: false, templates: false, aiMotion: true };
});

describe('POST /api/media/from-url/videos', () => {
  it('dryRun: plans and prices every product, charges and creates nothing', async () => {
    // A plain object: withUser (mocked here) is what serializes it.
    const body = await post({ products: PRODUCTS, platforms: ['instagram'], dryRun: true }) as unknown as Record<string, number> & { plans: { estimatedCredits: number }[] };
    expect(body.plans).toHaveLength(2);
    expect(body.plans[0]).toMatchObject({ name: 'Cold brew bottle', format: 'motion_graphic', estimatedCredits: expect.any(Number) });
    expect(body.totalCredits).toBe(body.plans[0].estimatedCredits + body.plans[1].estimatedCredits);
    expect(body).toMatchObject({ balance: 100_000, affordable: true });
    expect(st.submits).toHaveLength(0);
    expect(st.drafts).toHaveLength(0);
  });

  it('one render + one draft per product, linked by videoJobId and placed on Home', async () => {
    const r = await post({ products: PRODUCTS, platforms: ['instagram', 'tiktok'], durationSec: 12, timeZone: 'Asia/Kolkata' });
    expect(r.status).toBe(202);
    const body = await r.json();
    expect(body).toEqual({
      drafts: [
        { id: 'draft_1', name: 'Cold brew bottle', videoJobId: 'job_0', estimatedCredits: expect.any(Number) },
        { id: 'draft_2', name: 'Pour-over kettle', videoJobId: 'job_1', estimatedCredits: expect.any(Number) },
      ],
      failed: [],
    });
    // The user's length wins; each render is about its own product.
    expect(st.submits.map((s) => [s.topic, s.durationSec])).toEqual([[PRODUCTS[0].postText, 12], [PRODUCTS[1].postText, 12]]);
    expect(st.drafts[0]).toMatchObject({
      userId: 'user_1', title: 'Cold brew bottle', body: PRODUCTS[0].postText, targetPlatforms: ['instagram', 'tiktok'],
      videoJobId: 'job_0', source: 'user', plannedAt: expect.any(Date),
    });
    expect(st.drafts[1]).toMatchObject({ videoJobId: 'job_1', title: 'Pour-over kettle' });
    expect(st.spread).toEqual([['user_1', 'Asia/Kolkata', expect.any(Date), ['draft_1', 'draft_2']]]);
  });

  it('insufficient credits for the whole batch → 402 with balance/needed, nothing charged or created', async () => {
    const dry = await post({ products: PRODUCTS, dryRun: true }) as unknown as { totalCredits: number };
    st.balance = dry.totalCredits - 1;
    const r = await post({ products: PRODUCTS });
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: 'insufficient_credits', balance: dry.totalCredits - 1, needed: dry.totalCredits });
    expect(st.submits).toHaveLength(0);
    expect(st.drafts).toHaveLength(0);
  });

  it('one product failing keeps the others: 202 with the failure and its hint', async () => {
    st.failAt = { 1: new (SubmitFailure as unknown as new (c: string) => Error)('at_capacity') };
    const r = await post({ products: PRODUCTS });
    expect(r.status).toBe(202);
    const body = await r.json();
    expect(body.drafts.map((d: { name: string }) => d.name)).toEqual(['Cold brew bottle']);
    expect(body.failed).toEqual([{ name: 'Pour-over kettle', error: 'video_at_capacity', hint: expect.stringMatching(/Nothing was charged/) }]);
    expect(st.drafts).toHaveLength(1);
  });

  it('every product failing → the first failure, no drafts', async () => {
    st.failAt = { 0: new MotionNotReady(), 1: new MotionNotReady() };
    const r = await post({ products: PRODUCTS });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'brand_kit_incomplete' });
    expect(st.drafts).toHaveLength(0);
  });

  it('validates: http images, unknown platforms, too many products', async () => {
    expect((await post({ products: [{ ...PRODUCTS[0], imageUrls: ['http://shop.example/a.jpg'] }] })).status).toBe(400);
    expect((await post({ products: PRODUCTS, platforms: ['myspace'] })).status).toBe(400);
    expect((await post({ products: Array(9).fill(PRODUCTS[0]) })).status).toBe(400);
    expect(st.submits).toHaveLength(0);
  });

  it('no engine available → 503, nothing charged', async () => {
    st.av = { motion1: false, cinema: false, templates: false, aiMotion: false };
    const r = await post({ products: PRODUCTS });
    expect(r.status).toBe(503);
    expect(st.submits).toHaveLength(0);
  });
});
