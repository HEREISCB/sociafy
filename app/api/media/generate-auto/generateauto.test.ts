import { describe, it, expect, beforeEach, vi } from 'vitest';

/** POST /api/media/generate-auto: re-validate + re-price the plan (409 if it rose), then dispatch per kind, charging once. */
const st = vi.hoisted(() => ({
  balance: 100_000,
  av: { motion1: true, cinema: true, templates: true, aiMotion: true } as Record<string, boolean>,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  cinemaQuote: 33,
  fail: null as null | Error,
}));

const job = vi.hoisted(() => (fn: string, credits: (a: Record<string, unknown>) => number) => (args: Record<string, unknown>) => {
  st.calls.push({ fn, args });
  if (st.fail) return Promise.reject(st.fail);
  return Promise.resolve({ job: { id: `${fn}_job`, status: fn === 'hybrid' ? 'footage' : 'pending', durationSec: 12, aspect: '9:16' }, creditsCharged: credits(args), replayed: false });
});

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));
vi.mock('../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('../../../../lib/env', () => ({ isStubMode: { r2: () => false } }));
vi.mock('../../../../lib/ai/client', () => ({ getTextAI: () => null, getGroq: () => null, GROQ_MODELS: {}, completeText: () => Promise.resolve('') }));
vi.mock('../../../../lib/ai/cue', () => ({ priceCinemaRender: () => Promise.resolve({ credits: st.cinemaQuote, megapixels: 0.98, steps: 20, providerUsd: 0.29 }) }));
vi.mock('../../../../lib/media/autoVideo', async () => {
  const { z } = await import('zod');
  return {
    attachmentSchema: z.object({ url: z.string().url(), mimeType: z.string() }),
    brainContext: () => Promise.resolve({ balance: st.balance, availability: st.av }),
  };
});
vi.mock('../../../../lib/media/motionJob', () => ({
  MotionNotReady: class extends Error {},
  submitMotionAiVideo: job('motionAi', () => 216),
  submitMotionVideo: job('template', () => 270),
}));
vi.mock('../../../../lib/media/hybridJob', () => ({ startHybrid: job('hybrid', (a) => (a.plan as { estimatedCredits: number }).estimatedCredits) }));
vi.mock('../../../../lib/credits/ledger', () => ({
  InsufficientCreditsError: class extends Error { balance = 0; needed = 1; },
  insufficientCreditsResponse: () => ({ status: 402, error: 'insufficient_credits' }),
}));
vi.mock('../../v1/shared', () => ({
  SubmitFailure: class extends Error { constructor(readonly code: string) { super(code); } },
  submitVideo: job('video', () => 145),
  fetchReferenceImages: (urls: string[]) => { st.calls.push({ fn: 'fetch', args: { urls } }); return Promise.resolve({ ok: true, files: urls }); },
  rehostReferences: (_u: string, files: string[]) => Promise.resolve(files.map((_, i) => `https://media.sociafy.app/users/user_1/ref-${i}.jpg`)),
}));

import { POST } from './route';
import { finalizePlan, type Draft, type Plan } from '../../../../lib/ai/videoBrain';

const TEXT = 'Sunday mornings at our bakery: flour, butter, first light.';
const planFor = (d: Draft, text = TEXT, attachments: { url: string; mimeType: string }[] = []): Plan =>
  finalizePlan({ confidence: 0.9, ...d }, { text, platforms: ['instagram'], attachments, availability: st.av as never, balance: 100_000 });
const post = (body: unknown) =>
  POST(new Request('http://x/api/media/generate-auto', { method: 'POST', body: JSON.stringify(body) }) as never) as unknown as Promise<Response & Record<string, unknown>>;

beforeEach(() => {
  st.balance = 100_000; st.calls = []; st.cinemaQuote = 33; st.fail = null;
  st.av = { motion1: true, cinema: true, templates: true, aiMotion: true };
});

describe('POST /api/media/generate-auto', () => {
  it('ai_video → submitVideo with the plan footage; 202 with one job', async () => {
    const plan = planFor({ format: 'ai_video', footageEngine: 'motion-1-fast', durationSec: 8 });
    const r = await post({ text: TEXT, plan, platforms: ['instagram'] });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ kind: 'ai_video', jobs: [{ id: 'video_job', status: 'pending', durationSec: 12, aspect: '9:16', creditsCharged: 145 }], creditsChargedTotal: 145 });
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0].args).toMatchObject({ model: 'sociafy-motion-1', fast: true, durationSec: 8, quality: '720p', aspect: '9:16', genMode: 'text', source: null, via: 'compose', prompt: plan.footage!.prompt });
  });

  it('Cinema: re-priced by the live quote; a dearer quote is a 409 with nothing submitted', async () => {
    const plan = planFor({ format: 'ai_video', footageEngine: 'cinema-1', durationSec: 8 });
    expect(plan.estimatedCredits).toBe(33);
    st.cinemaQuote = 40;
    expect(await post({ text: TEXT, plan, platforms: ['instagram'] })).toMatchObject({ error: 'plan_changed', status: 409, estimatedCredits: 40 });
    expect(st.calls).toHaveLength(0);
    st.cinemaQuote = 30;
    expect((await post({ text: TEXT, plan, platforms: ['instagram'] })).status).toBe(202);
    expect(st.calls[0].args).toMatchObject({ model: 'sociafy-cinema-1', prompt: expect.stringMatching(/Audio:/) });
  });

  it('a tampered (under-priced) plan is re-priced → 409 plan_changed with the fresh plan', async () => {
    const plan = { ...planFor({ format: 'hybrid', footageSeconds: 6, durationSec: 12 }), estimatedCredits: 10 };
    const r = await post({ text: TEXT, plan, platforms: ['instagram'] });
    expect(r).toMatchObject({ error: 'plan_changed', status: 409, plan: { format: 'hybrid' } });
    expect(st.calls).toHaveLength(0);
  });

  it('a format the server can no longer run is a 409, not a silent swap', async () => {
    const plan = planFor({ format: 'hybrid' });
    st.av = { ...st.av, motion1: false };
    expect(await post({ text: TEXT, plan, platforms: ['instagram'] })).toMatchObject({ error: 'plan_changed', status: 409, plan: { format: 'motion_graphic' } });
  });

  it('hybrid → startHybrid once with the validated plan; the job reads pending', async () => {
    const plan = planFor({ format: 'hybrid', footageSeconds: 6, durationSec: 12, audio: { music: true } });
    const r = await post({ text: TEXT, plan, platforms: ['instagram'] });
    const body = await r.json();
    expect(body).toMatchObject({ kind: 'hybrid', creditsChargedTotal: plan.estimatedCredits, jobs: [{ id: 'hybrid_job', status: 'pending' }] });
    expect(st.calls.map((c) => c.fn)).toEqual(['hybrid']);
    expect(st.calls[0].args).toMatchObject({ userId: 'user_1', topic: TEXT, plan: { format: 'hybrid', estimatedCredits: plan.estimatedCredits } });
  });

  it('image-to-video footage re-hosts the photo before dispatch', async () => {
    const photo = [{ url: 'https://example.com/bottle.jpg', mimeType: 'image/jpeg' }];
    const text = 'Our new cold brew is here. ₹199 this weekend only.';
    const plan = planFor({ format: 'hybrid', footageEngine: 'motion-1', footageMode: 'image-to-video' }, text, photo);
    expect((await post({ text, plan, platforms: ['instagram'], attachments: photo })).status).toBe(202);
    expect(st.calls.map((c) => c.fn)).toEqual(['fetch', 'hybrid']);
    expect(st.calls[1].args.imageUrls).toEqual(['https://media.sociafy.app/users/user_1/ref-0.jpg']);
  });

  it('motion_graphic → AI motion with the plan audio, or the template', async () => {
    const ai = planFor({ format: 'motion_graphic', durationSec: 12, audio: { music: false } });
    expect((await post({ text: TEXT, plan: ai, platforms: ['instagram'] })).status).toBe(202);
    expect(st.calls[0]).toMatchObject({ fn: 'motionAi', args: { aspect: '9:16', durationSec: 12, audio: ai.audio, topic: TEXT } });
    // Best fit never picks a template now; an approved one (the ladder's sting, say) still runs as a template.
    const tpl = finalizePlan({ confidence: 0.9, format: 'motion_graphic', graphicsEngine: 'template', template: 'stat' },
      { text: TEXT, platforms: ['instagram'], attachments: [], availability: st.av as never, balance: 100_000 }, { revalidate: true });
    expect((await post({ text: TEXT, plan: tpl, platforms: ['instagram'] })).status).toBe(202);
    expect(st.calls[1]).toMatchObject({ fn: 'template', args: { template: 'stat', aspect: '9:16' } });
  });

  it('insufficient credits → 402; a provider failure → white-labelled 502', async () => {
    const plan = planFor({ format: 'motion_graphic', durationSec: 12 });
    const { InsufficientCreditsError } = await import('../../../../lib/credits/ledger');
    st.fail = new InsufficientCreditsError(0, 216);
    expect(await post({ text: TEXT, plan })).toMatchObject({ status: 402, error: 'insufficient_credits' });
    st.fail = new Error('motion_ai_500: claude exploded');
    const r = await post({ text: TEXT, plan });
    expect(r).toMatchObject({ error: 'video_submit_failed', status: 502 });
    expect(JSON.stringify(r)).not.toMatch(/claude/i);
  });

  it('an unaffordable plan → 402 insufficient_credits before any fetch, re-host or charge', async () => {
    const photo = [{ url: 'https://example.com/bottle.jpg', mimeType: 'image/jpeg' }];
    const text = 'Our new cold brew is here. ₹199 this weekend only.';
    const plan = planFor({ format: 'hybrid', footageEngine: 'motion-1', footageMode: 'image-to-video' }, text, photo);
    st.balance = 22;
    expect(await post({ text, plan, platforms: ['instagram'], attachments: photo })).toMatchObject({ status: 402, error: 'insufficient_credits' });
    expect(st.calls).toHaveLength(0);
  });

  it('rejects a malformed plan', async () => {
    expect((await post({ text: TEXT, plan: { format: 'gif' } })).status).toBe(400);
  });
});
