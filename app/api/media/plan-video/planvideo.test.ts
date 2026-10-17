import { describe, it, expect, beforeEach, vi } from 'vitest';

/** POST /api/media/plan-video: validated body → brain plan + balance; no charge, rate-limited. */
const st = vi.hoisted(() => ({ rl: true, balance: 5_000, aiMotion: true }));

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));
vi.mock('../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: st.rl, retryAfterSec: 5 }) }));
vi.mock('../../../../lib/ai/client', () => ({ getTextAI: () => null, getGroq: () => null, GROQ_MODELS: {}, completeText: () => Promise.resolve('') }));
vi.mock('../../../../lib/media/autoVideo', async () => {
  const { z } = await import('zod');
  return {
    attachmentSchema: z.object({ url: z.string().url(), mimeType: z.string() }),
    brainContext: () => Promise.resolve({ balance: st.balance, availability: { motion1: true, cinema: true, templates: true, aiMotion: st.aiMotion } }),
  };
});

import { POST } from './route';
import { VENDOR_RX } from '../../../../lib/ai/videoBrain';

const post = (body: unknown) =>
  POST(new Request('http://x/api/media/plan-video', { method: 'POST', body: JSON.stringify(body) }) as never) as unknown as Promise<Record<string, unknown> & { status?: number }>;

beforeEach(() => { st.rl = true; st.balance = 5_000; st.aiMotion = true; });

describe('POST /api/media/plan-video', () => {
  it('returns the plan, its price, a vendor-free summary, alternatives and the balance', async () => {
    const r = await post({ text: 'Sunday mornings at our bakery: flour, butter, first light.', platforms: ['Instagram'] });
    expect(r).toMatchObject({ plan: { format: 'ai_video', aspect: '9:16' }, balance: 5_000 });
    expect(r.estimatedCredits).toBe((r.plan as { estimatedCredits: number }).estimatedCredits);
    expect(typeof r.summary).toBe('string');
    expect(Array.isArray(r.reasons)).toBe(true);
    expect((r.alternatives as unknown[]).length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(r)).not.toMatch(VENDOR_RX);
  });

  it('a low balance still returns the priced best fit, affordable:false and the cheapest option', async () => {
    st.balance = 22;
    const r = await post({ text: 'Sunday mornings at our bakery: flour, butter, first light.', platforms: ['instagram'] });
    expect(r).toMatchObject({ plan: { format: 'ai_video' }, affordable: false, balance: 22, cheapest: { estimatedCredits: expect.any(Number) } });
    expect(r.estimatedCredits as number).toBeGreaterThan(22);
  });

  it('honours an override format', async () => {
    const r = await post({ text: 'Sunday mornings at our bakery: flour, butter, first light.', overrides: { format: 'motion_graphic', aspect: '1:1' } });
    expect(r.plan).toMatchObject({ format: 'motion_graphic', aspect: '1:1' });
  });

  it('rejects a bad body and a rate-limited caller', async () => {
    expect(((await post({ text: 'x'.repeat(4_001) })) as unknown as Response).status).toBe(400);
    expect(((await post({ text: 'ok then', overrides: { format: 'gif' } })) as unknown as Response).status).toBe(400);
    st.rl = false;
    expect(await post({ text: 'Hello there' })).toMatchObject({ error: 'rate_limited', status: 429 });
  });
});
