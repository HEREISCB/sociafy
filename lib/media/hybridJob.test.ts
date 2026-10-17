import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Hybrid lifecycle: charge once up front → footage child → parent submitted once with the footage, or the fallback. */
type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  tables: { jobs: [] as Row[], parts: [] as Row[], assets: [] as Row[] },
  charges: [] as Row[],
  refunds: [] as Row[],
  seedance: [] as Row[],
  motion: [] as Row[],
  motionSubmit: null as null | (() => Promise<{ callId: string }>),
  seedanceSubmit: null as null | (() => Promise<string>),
  partsInsertFails: false,
  /** What finalizeVideoJob(child) turns the child into. */
  childOutcome: 'pending' as 'pending' | 'completed' | 'failed',
  n: 0,
}));

type Pred = (r: Row) => boolean;
vi.mock('drizzle-orm', () => ({
  and: (...ps: Pred[]) => (r: Row) => ps.every((p) => p(r)),
  eq: (c: { __c: string }, v: unknown) => (r: Row) => r[c.__c] === v,
  inArray: (c: { __c: string }, vs: unknown[]) => (r: Row) => vs.includes(r[c.__c]),
  asc: (c: { __c: string }) => c.__c,
}));
vi.mock('../db/schema', () => {
  const cols = (t: string, ...cs: string[]) => Object.fromEntries([['__t', t], ...cs.map((c) => [c, { __c: c }])]);
  return {
    videoJobs: cols('jobs', 'id', 'status', 'updatedAt'),
    hybridParts: cols('parts', 'parentJobId', 'childJobId'),
    mediaAssets: cols('assets', 'id', 'publicUrl'),
  };
});
vi.mock('../db', () => {
  const tbl = (t: { __t: keyof typeof st.tables }) => st.tables[t.__t];
  const thenable = (rows: Row[]) => ({ returning: () => Promise.resolve(rows), then: (r: (x: unknown) => unknown) => Promise.resolve(undefined).then(r) });
  return {
    db: () => ({
      insert: (t: { __t: keyof typeof st.tables }) => ({
        values: (v: Row) => {
          if (t.__t === 'parts' && st.partsInsertFails) return { then: (_r: unknown, rej: (e: unknown) => unknown) => Promise.reject(new Error('relation "hybrid_parts" does not exist')).catch(rej) };
          const row = { id: `${t.__t}_${++st.n}`, createdAt: new Date(), updatedAt: new Date(), creditLedgerId: null, mediaAssetId: null, ...v };
          tbl(t).push(row);
          return { returning: () => Promise.resolve([row]), then: (r: (x: unknown) => unknown) => Promise.resolve(undefined).then(r) };
        },
      }),
      update: (t: { __t: keyof typeof st.tables }) => ({
        set: (v: Row) => ({
          where: (p: Pred) => {
            const hit = tbl(t).filter(p);
            hit.forEach((r) => Object.assign(r, v));
            return thenable(hit.map((r) => ({ ...r })));
          },
        }),
      }),
      select: () => ({
        from: (t: { __t: keyof typeof st.tables }) => ({
          where: (p: Pred) => {
            const rows = () => tbl(t).filter(p).map((r) => ({ ...r }));
            return {
              limit: (n: number) => Promise.resolve(rows().slice(0, n)),
              orderBy: () => ({ limit: (n: number) => Promise.resolve(rows().slice(0, n)) }),
            };
          },
        }),
      }),
    }),
  };
});
vi.mock('../credits/ledger', () => {
  class InsufficientCreditsError extends Error {
    constructor(readonly balance: number, readonly needed: number) { super('insufficient'); }
  }
  return {
    InsufficientCreditsError,
    ensureBalance: () => Promise.resolve({ ok: true, balance: 10_000 }),
    charge: (a: Row) => { st.charges.push(a); return Promise.resolve({ ledgerId: `led_${st.charges.length}`, balanceAfter: 0 }); },
    refund: (a: Row) => { st.refunds.push(a); return Promise.resolve({ refunded: true }); },
  };
});
vi.mock('../ai/piapi', () => ({ createSeedanceTask: (a: Row) => { st.seedance.push(a); return st.seedanceSubmit!(); } }));
vi.mock('../ai/motionAi', () => ({ submitMotionAi: (a: Row) => { st.motion.push(a); return st.motionSubmit!(); } }));
vi.mock('../brand/kit', () => ({ motionAiReady: () => true }));
vi.mock('../storage/r2', () => ({ makeMediaKey: (u: string, n: string) => `users/${u}/${n}` }));
vi.mock('./motionJob', () => ({
  MotionNotReady: class extends Error {},
  AMBIGUOUS_SUBMIT_RX: /ETIMEDOUT|TimeoutError/,
  loadBrand: () => Promise.resolve({ kit: {}, profile: { companyName: 'Acme', website: null } }),
  motionAiBrand: () => ({ brandName: 'Acme', colors: { primary: '#111111', secondary: '#222222', background: '#FFFFFF', text: '#111111', accent: '#222222' } }),
}));
vi.mock('./finalizeVideoJob', () => ({
  HYBRID_WAITING: 'footage',
  HYBRID_SUBMITTING: 'hybrid_submitting',
  MAX_AGE_MS: 2 * 60 * 60_000,
  finalizeVideoJob: (job: Row) => {
    const row = st.tables.jobs.find((r) => r.id === job.id)!;
    if (st.childOutcome === 'completed' && row.status === 'pending') {
      st.tables.assets.push({ id: 'asset_1', publicUrl: 'https://media.sociafy.app/users/u1/vid.mp4' });
      Object.assign(row, { status: 'completed', mediaAssetId: 'asset_1' });
    } else if (st.childOutcome === 'failed' && row.status === 'pending') {
      Object.assign(row, { status: 'failed', error: 'piapi_failed: refused' });
    }
    return Promise.resolve({ status: row.status });
  },
}));

import { advanceHybrid, advanceHybrids, startHybrid } from './hybridJob';
import { finalizePlan, FOOTAGE_NEGATIVE, type Plan } from '../ai/videoBrain';

const AV = { motion1: true, cinema: true, templates: true, aiMotion: true };
const plan: Plan = finalizePlan(
  { format: 'hybrid', recipe: 'H1', footageEngine: 'motion-1-fast', footageSeconds: 6, durationSec: 12, audio: { music: true }, confidence: 0.9, onScreenText: ['1,000 orders'] },
  { text: 'Behind the scenes: our team packing 1,000 orders before Diwali', platforms: ['instagram'], attachments: [], availability: AV, balance: 100_000 },
);
const HYBRID = 109 + 264; // 6 s Fast 720p + 12 s AI motion with music
const FALLBACK = 264;

const start = () => startHybrid({ userId: 'u1', plan, topic: 'Behind the scenes: our team packing 1,000 orders before Diwali', via: 'compose' });
const parent = () => st.tables.jobs.find((r) => r.genMode === 'motion-ai-hybrid' || r.provider === 'motion-claude')!;
const child = () => st.tables.jobs.find((r) => r.provider !== 'motion-claude')!;
const fresh = (): never => ({ ...parent() }) as never;

beforeEach(() => {
  st.tables = { jobs: [], parts: [], assets: [] };
  st.charges = []; st.refunds = []; st.seedance = []; st.motion = [];
  st.motionSubmit = () => Promise.resolve({ callId: 'call_1' });
  st.seedanceSubmit = () => Promise.resolve('task_1');
  st.partsInsertFails = false;
  st.childOutcome = 'pending';
});

describe('startHybrid', () => {
  it('charges the full hybrid price once, on the parent; the footage child is internal and free', async () => {
    expect(plan).toMatchObject({ format: 'hybrid', estimatedCredits: HYBRID, fallback: { estimatedCredits: FALLBACK } });
    const { job, creditsCharged } = await start();
    expect(creditsCharged).toBe(HYBRID);
    expect(st.charges).toHaveLength(1);
    expect(st.charges[0]).toMatchObject({ userId: 'u1', action: 'video_motion_ai', credits: HYBRID, meta: { videoJobId: job.id, hybrid: true } });
    expect(parent()).toMatchObject({ status: 'footage', provider: 'motion-claude', creditLedgerId: 'led_1', creditsCharged: HYBRID, durationSec: 12, providerTaskId: '' });
    expect(child()).toMatchObject({ status: 'pending', provider: 'piapi-seedance-2-fast', creditsCharged: 0, creditLedgerId: null, providerTaskId: 'task_1', durationSec: 6, quality: '720p' });
    expect(st.tables.parts[0]).toMatchObject({ parentJobId: parent().id, childJobId: child().id, role: 'footage', spec: { fallbackCredits: FALLBACK, clip: { startSec: 2, durationSec: 6 } } });
    expect(st.seedance[0]).toMatchObject({ mode: 'text_to_video', fast: true, durationSec: 6, resolution: '720p' });
    expect(String(st.seedance[0].prompt)).toContain(FOOTAGE_NEGATIVE);
  });

  it('a missing link table fails both rows before any charge', async () => {
    st.partsInsertFails = true;
    await expect(start()).rejects.toThrow('hybrid_parts');
    expect(st.charges).toHaveLength(0);
    expect(st.tables.jobs.every((r) => r.status === 'failed')).toBe(true);
    expect(st.seedance).toHaveLength(0);
  });

  it('a refused footage submit does not fail the request; the child is closed for the fallback', async () => {
    st.seedanceSubmit = () => Promise.reject(new Error('piapi_400: bad'));
    await start();
    expect(child()).toMatchObject({ status: 'failed' });
    expect(parent()).toMatchObject({ status: 'footage' });
  });
});

describe('advanceHybrid', () => {
  it('waits while the footage renders', async () => {
    await start();
    await advanceHybrid(fresh());
    expect(st.motion).toHaveLength(0);
    expect(parent().status).toBe('footage');
  });

  it('footage done → parent submitted exactly once with the footage url; double finalize is safe', async () => {
    await start();
    st.childOutcome = 'completed';
    const snapshot = fresh();
    await Promise.all([advanceHybrid(snapshot), advanceHybrid(snapshot)]);
    await advanceHybrid(fresh());
    await advanceHybrids();
    expect(st.motion).toHaveLength(1);
    expect(st.motion[0]).toMatchObject({
      aspect: '9:16', durationSec: 12, audio: { music: true },
      footage: [{ url: 'https://media.sociafy.app/users/u1/vid.mp4', startSec: 2, durationSec: 6 }],
    });
    expect((st.motion[0].brand as { colors: Record<string, string> }).colors).toHaveProperty('accent');
    expect(String(st.motion[0].prompt)).toMatch(/On-screen text to feature: 1,000 orders/);
    expect(parent()).toMatchObject({ status: 'pending', providerTaskId: 'call_1', creditsCharged: HYBRID });
    expect(st.charges).toHaveLength(1);
    expect(st.refunds).toHaveLength(0);
  });

  it('footage failed → plain motion graphic; the user ends up paying only the fallback', async () => {
    await start();
    st.childOutcome = 'failed';
    await Promise.all([advanceHybrid(fresh()), advanceHybrid(fresh())]);
    await advanceHybrid(fresh());
    expect(st.motion).toHaveLength(1);
    expect(st.motion[0].footage).toBeUndefined();
    expect(st.refunds).toEqual([expect.objectContaining({ ledgerId: 'led_1', reason: 'hybrid_footage_failed' })]);
    expect(st.charges.map((c) => c.credits)).toEqual([HYBRID, FALLBACK]);
    const net = st.charges.reduce((s, c) => s + Number(c.credits), 0) - HYBRID; // refund returned the first charge in full
    expect(net).toBe(FALLBACK);
    expect(parent()).toMatchObject({ status: 'pending', creditLedgerId: 'led_2', creditsCharged: FALLBACK, genMode: 'motion-ai', providerTaskId: 'call_1' });
  });

  it('fallback submit fails too → parent failed and the fallback charge refunded (full refund overall)', async () => {
    await start();
    st.childOutcome = 'failed';
    st.motionSubmit = () => Promise.reject(new Error('motion_ai_500: down'));
    await advanceHybrid(fresh());
    expect(parent()).toMatchObject({ status: 'failed' });
    expect(st.refunds.map((r) => r.ledgerId)).toEqual(['led_1', 'led_2']);
  });

  it('hybrid submit refused → parent failed, full refund', async () => {
    await start();
    st.childOutcome = 'completed';
    st.motionSubmit = () => Promise.reject(new Error('motion_ai_400: bad_footage'));
    await advanceHybrid(fresh());
    expect(parent()).toMatchObject({ status: 'failed' });
    expect(st.refunds).toEqual([expect.objectContaining({ ledgerId: 'led_1' })]);
  });

  it('stuck past the max age → failed + full refund, once', async () => {
    await start();
    parent().createdAt = new Date(Date.now() - 3 * 60 * 60_000);
    await advanceHybrid(fresh());
    await advanceHybrid({ ...parent(), status: 'footage' } as never);
    expect(parent()).toMatchObject({ status: 'failed', error: 'provider_stuck' });
    expect(st.refunds).toHaveLength(1);
    expect(st.motion).toHaveLength(0);
  });
});
