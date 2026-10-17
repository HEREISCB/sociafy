import { describe, it, expect, beforeEach, vi } from 'vitest';

/** submitMotionVideo: copy → row → charge → submit; refund on a definitive submit failure. */
const st = vi.hoisted(() => ({
  kit: {} as Record<string, unknown>,
  profile: { companyName: 'IndusLabs', website: 'https://induslabs.in' } as Record<string, unknown>,
  balance: 100,
  rows: [] as Record<string, unknown>[],
  charges: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  submit: null as null | (() => Promise<{ callId: string }>),
  submitted: [] as Record<string, unknown>[],
}));

vi.mock('../db', () => {
  const row = () => st.rows[st.rows.length - 1];
  return {
    db: () => ({
      select: () => ({
        from: (t: { __t: string }) => ({
          where: () => ({ limit: () => Promise.resolve(t.__t === 'kits' ? [{ kit: st.kit }] : [st.profile]) }),
        }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: () => { const r = { id: 'job_1', ...v }; st.rows.push(r); return Promise.resolve([r]); },
        }),
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: () => {
            Object.assign(row(), v);
            return { returning: () => Promise.resolve([row()]), then: (r: (x: unknown) => unknown) => Promise.resolve(undefined).then(r) };
          },
        }),
      }),
    }),
  };
});
vi.mock('drizzle-orm', () => ({ eq: () => null }));
vi.mock('../db/schema', () => ({ brandKits: { __t: 'kits' }, agentSettings: { __t: 'settings' }, videoJobs: { __t: 'jobs' } }));
vi.mock('../storage/r2', () => ({ makeMediaKey: (u: string, n: string) => `users/${u}/${n}` }));
vi.mock('../ai/motionCopy', () => ({ writeMotionCopy: () => Promise.resolve({ hook: 'Calls, *handled*', lines: ['Try it'], facts: ['12 languages'] }) }));
vi.mock('../ai/motion', () => ({
  submitMotion: (a: Record<string, unknown>) => { st.submitted.push(a); return st.submit!(); },
}));
vi.mock('../ai/motionAi', () => ({
  submitMotionAi: (a: Record<string, unknown>) => { st.submitted.push(a); return st.submit!(); },
}));
vi.mock('../credits/ledger', () => {
  class InsufficientCreditsError extends Error {
    constructor(readonly balance: number, readonly needed: number) { super('insufficient'); }
  }
  return {
    InsufficientCreditsError,
    ensureBalance: (_u: string, n: number) => Promise.resolve(st.balance >= n ? { ok: true, balance: st.balance } : { ok: false, balance: st.balance, needed: n }),
    charge: (a: Record<string, unknown>) => { st.charges.push(a); return Promise.resolve({ ledgerId: 'led_1', balanceAfter: 0 }); },
    refund: (a: Record<string, unknown>) => { st.refunds.push(a); return Promise.resolve({ refunded: true }); },
  };
});

import { MotionNotReady, autopilotTemplate, submitMotionAiVideo, submitMotionVideo } from './motionJob';

const READY = { logo: { primary: { id: 'l', url: 'https://cdn/logo.svg', mime: 'image/svg+xml' } }, colors: { primary: '#5B5EF2' }, facts: ['12 languages'] };
const go = () => submitMotionVideo({ userId: 'u1', template: 'stat', aspect: '9:16', topic: 'Hindi support is live', via: 'compose' });

beforeEach(() => {
  st.kit = READY; st.balance = 100; st.rows = []; st.charges = []; st.refunds = []; st.submitted = [];
  st.submit = () => Promise.resolve({ callId: 'fc-1' });
});

describe('submitMotionVideo', () => {
  it('writes the row, charges the flat price, submits into the user prefix', async () => {
    const { job, creditsCharged } = await go();
    expect(creditsCharged).toBe(10);
    expect(st.charges[0]).toMatchObject({ action: 'video_motion_graphics', credits: 10, meta: { videoJobId: 'job_1', template: 'stat', via: 'compose' } });
    expect(job).toMatchObject({ provider: 'motion-hf', providerTaskId: 'fc-1', creditLedgerId: 'led_1', durationSec: 15, genMode: 'motion-stat' });
    const sent = st.submitted[0] as { videoKey: string; posterKey: string; vars: Record<string, unknown> };
    expect(sent.videoKey).toMatch(/^users\/u1\//);
    expect(sent.posterKey).toMatch(/^users\/u1\/.*\.jpg$/);
    expect(sent.vars).toMatchObject({ brandName: 'IndusLabs', hook: 'Calls, *handled*', facts: ['12 languages'], colors: { primary: '#5B5EF2' } });
  });

  it('refuses an incomplete kit and a short balance before charging anything', async () => {
    st.kit = { colors: { primary: '#5B5EF2' } };
    await expect(go()).rejects.toBeInstanceOf(MotionNotReady);
    st.kit = READY; st.balance = 3;
    await expect(go()).rejects.toThrow('insufficient');
    expect(st.rows).toHaveLength(0);
    expect(st.charges).toHaveLength(0);
  });

  it('refunds a definitive submit failure and fails the row', async () => {
    st.submit = () => Promise.reject(new Error('motion_500: boom'));
    await expect(go()).rejects.toThrow('motion_500');
    expect(st.rows[0]).toMatchObject({ status: 'failed' });
    expect(st.refunds).toEqual([expect.objectContaining({ ledgerId: 'led_1', meta: { videoJobId: 'job_1' } })]);
  });

  it('leaves an ambiguous (timed-out) submit pending for the sweeper, unrefunded', async () => {
    st.submit = () => Promise.reject(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
    const { job } = await go();
    expect(job.status).toBe('pending');
    expect(job.providerTaskId).toBe('');
    expect(st.refunds).toHaveLength(0);
  });
});

describe('autopilotTemplate', () => {
  it('facts → stat, screenshots → showcase, else stat', () => {
    expect(autopilotTemplate({ facts: ['a'] })).toBe('stat');
    const shot = { id: 's', url: 'u', mime: 'image/png' };
    expect(autopilotTemplate({ screenshots: [shot, shot] })).toBe('showcase');
    expect(autopilotTemplate({})).toBe('stat');
  });
});

describe('submitMotionAiVideo', () => {
  const ai = (durationSec = 15) => submitMotionAiVideo({ userId: 'u1', aspect: '1:1', durationSec, topic: 'Hindi support is live', via: 'compose' });

  it('charges by length, then submits the post text + brand into the user prefix', async () => {
    const { job, creditsCharged } = await ai();
    expect(creditsCharged).toBe(30);
    expect(st.charges[0]).toMatchObject({ action: 'video_motion_ai', credits: 30, meta: { videoJobId: 'job_1', template: 'ai', durationSec: 15 } });
    expect(job).toMatchObject({ provider: 'motion-claude', genMode: 'motion-ai', providerTaskId: 'fc-1', creditLedgerId: 'led_1', durationSec: 15, aspect: '1:1' });
    const sent = st.submitted[0] as { prompt: string; durationSec: number; videoKey: string; posterKey: string; brand: Record<string, unknown> };
    expect(sent).toMatchObject({ prompt: 'Hindi support is live', aspect: '1:1', durationSec: 15 });
    expect(sent.videoKey).toMatch(/^users\/u1\/.*\.mp4$/);
    expect(sent.posterKey).toMatch(/^users\/u1\/.*\.jpg$/);
    expect(sent.brand).toMatchObject({ brandName: 'IndusLabs', logoUrl: 'https://cdn/logo.svg', colors: { primary: '#5B5EF2' }, style: 'soft' });
  });

  it('runs without a logo, but not without a main color — refusing before any charge', async () => {
    st.kit = { colors: { primary: '#5B5EF2' } };
    await expect(ai(6)).resolves.toMatchObject({ creditsCharged: 12 });
    expect((st.submitted[0] as { brand: Record<string, unknown> }).brand.logoUrl).toBeUndefined();
    st.rows = []; st.charges = [];
    st.kit = { logo: READY.logo };
    await expect(ai()).rejects.toBeInstanceOf(MotionNotReady);
    st.kit = READY; st.balance = 20;
    await expect(ai(20)).rejects.toThrow('insufficient');
    expect(st.rows).toHaveLength(0);
    expect(st.charges).toHaveLength(0);
  });

  it('refunds a definitive submit rejection and fails the row', async () => {
    st.submit = () => Promise.reject(new Error('motion_ai_503: busy'));
    await expect(ai()).rejects.toThrow('motion_ai_503');
    expect(st.rows[0]).toMatchObject({ status: 'failed' });
    expect(st.refunds).toEqual([expect.objectContaining({ ledgerId: 'led_1', meta: { videoJobId: 'job_1' } })]);
  });
});
