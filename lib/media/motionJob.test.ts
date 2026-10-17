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
  /** Order of side effects, to prove the parent link precedes the charge. */
  log: [] as string[],
  edits: [] as Record<string, unknown>[],
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
  editMotionAi: (a: Record<string, unknown>) => { st.log.push('submit'); st.submitted.push(a); return st.submit!(); },
}));
vi.mock('./motionVersions', () => ({
  rootOf: (id: string) => Promise.resolve(id === 'parent_v2' ? 'parent_v1' : id),
  recordEdit: (a: Record<string, unknown>) => { st.log.push('record'); st.edits.push(a); return Promise.resolve(); },
}));
vi.mock('../credits/ledger', () => {
  class InsufficientCreditsError extends Error {
    constructor(readonly balance: number, readonly needed: number) { super('insufficient'); }
  }
  return {
    InsufficientCreditsError,
    ensureBalance: (_u: string, n: number) => Promise.resolve(st.balance >= n ? { ok: true, balance: st.balance } : { ok: false, balance: st.balance, needed: n }),
    charge: (a: Record<string, unknown>) => { st.log.push('charge'); st.charges.push(a); return Promise.resolve({ ledgerId: 'led_1', balanceAfter: 0 }); },
    refund: (a: Record<string, unknown>) => { st.refunds.push(a); return Promise.resolve({ refunded: true }); },
  };
});

import { MotionNotReady, autopilotTemplate, submitMotionAiEdit, submitMotionAiVideo, submitMotionVideo } from './motionJob';

const READY = { logo: { primary: { id: 'l', url: 'https://cdn/logo.svg', mime: 'image/svg+xml' } }, colors: { primary: '#5B5EF2' }, facts: ['12 languages'] };
const go = () => submitMotionVideo({ userId: 'u1', template: 'stat', aspect: '9:16', topic: 'Hindi support is live', via: 'compose' });

beforeEach(() => {
  st.kit = READY; st.balance = 100; st.rows = []; st.charges = []; st.refunds = []; st.submitted = []; st.log = []; st.edits = [];
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

  it('charges the voiceover surcharge and sends the audio choice to the worker', async () => {
    const audio = { narration: true, sfx: true, music: false, language: 'hi' };
    const { creditsCharged } = await submitMotionAiVideo({ userId: 'u1', aspect: '9:16', durationSec: 15, topic: 'Hindi support is live', via: 'compose', audio });
    expect(creditsCharged).toBe(45);
    expect(st.charges[0]).toMatchObject({ credits: 45, meta: { audio } });
    expect(st.submitted[0]).toMatchObject({ audio });
    st.charges = []; st.submitted = []; st.rows = [];
    await expect(ai()).resolves.toMatchObject({ creditsCharged: 30 });
    expect(st.submitted[0]).not.toHaveProperty('audio');
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

describe('submitMotionAiEdit', () => {
  const parent = { id: 'parent_v2', providerTaskId: 'call-v2', durationSec: 15, aspect: '9:16' };
  const edit = (over: Record<string, unknown> = {}) =>
    submitMotionAiEdit({ userId: 'u1', parent: { ...parent, ...over }, segmentId: 'seg-2', instruction: 'Make the logo bigger' });

  it('links the parent, charges 1 cr/s, then submits against the PARENT callId into the user prefix', async () => {
    const { job, creditsCharged } = await edit();
    expect(creditsCharged).toBe(15);
    expect(st.log).toEqual(['record', 'charge', 'submit']);
    expect(st.charges[0]).toMatchObject({ action: 'video_motion_ai_edit', credits: 15, meta: { videoJobId: 'job_1', parentJobId: 'parent_v2' } });
    expect(st.edits[0]).toEqual({ jobId: 'job_1', rootJobId: 'parent_v1', parentJobId: 'parent_v2', segmentId: 'seg-2', instruction: 'Make the logo bigger' });
    expect(job).toMatchObject({ provider: 'motion-claude', genMode: 'motion-ai-edit', providerTaskId: 'fc-1', durationSec: 15, aspect: '9:16', prompt: 'Make the logo bigger' });
    const sent = st.submitted[0] as Record<string, string>;
    expect(sent).toMatchObject({ parentCallId: 'call-v2', segmentId: 'seg-2', instruction: 'Make the logo bigger' });
    expect(sent.videoKey).toMatch(/^users\/u1\/.*\.mp4$/);
    expect(sent.posterKey).toMatch(/^users\/u1\/.*\.jpg$/);
  });

  it('prices by the length of the video being edited: 6 / 20 → 6 / 20', async () => {
    expect((await edit({ durationSec: 6 })).creditsCharged).toBe(6);
    expect((await edit({ durationSec: 20 })).creditsCharged).toBe(20);
  });

  it('refuses a short balance before writing anything', async () => {
    st.balance = 10;
    await expect(edit()).rejects.toThrow('insufficient');
    expect(st.rows).toHaveLength(0);
    expect(st.charges).toHaveLength(0);
  });

  it('refunds a definitive rejection (parent gone) and fails the row', async () => {
    st.submit = () => Promise.reject(new Error('motion_ai_404: {"error":"parent_not_found"}'));
    await expect(edit()).rejects.toThrow('motion_ai_404');
    expect(st.rows[0]).toMatchObject({ status: 'failed' });
    expect(st.refunds).toEqual([expect.objectContaining({ ledgerId: 'led_1', meta: { videoJobId: 'job_1' } })]);
  });

  it('leaves an ambiguous submit pending for the sweeper, unrefunded', async () => {
    st.submit = () => Promise.reject(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
    const { job } = await edit();
    expect(job.status).toBe('pending');
    expect(st.refunds).toHaveLength(0);
  });
});
