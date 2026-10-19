import { describe, it, expect, beforeEach, vi } from 'vitest';

/** POST /api/compose/chat: validated chat → post/duration/platforms; charged per message, refunded on failure. */
const st = vi.hoisted(() => ({
  rl: true,
  balance: 100,
  ai: true as boolean,
  llm: vi.fn<() => Promise<string>>(),
  charge: vi.fn(() => Promise.resolve({ ledgerId: 'led_1', balanceAfter: 99 })),
  refund: vi.fn(() => Promise.resolve({ refunded: true, balanceAfter: 100 })),
}));

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));
vi.mock('../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: st.rl, retryAfterSec: 5 }) }));
vi.mock('../../../../lib/ai/client', () => ({
  getTextAI: () => (st.ai ? { kind: 'openai', model: 'm' } : null),
  completeText: () => st.llm(),
}));
vi.mock('../../../../lib/ai/brand-context', () => ({ loadBrandContext: () => Promise.resolve(null), renderBrandBlock: () => '' }));
vi.mock('../../../../lib/credits/ledger', () => ({
  ensureBalance: (_u: string, needed: number) => Promise.resolve(st.balance >= needed ? { ok: true, balance: st.balance } : { ok: false, balance: st.balance, needed }),
  charge: st.charge,
  refund: st.refund,
  insufficientCreditsResponse: (b: { balance: number; needed: number }) => ({ error: 'insufficient_credits', status: 402, ...b }),
}));

import { POST } from './route';
import { priceForCompose } from '../../../../lib/credits/pricing';

type R = Record<string, unknown> & { status?: number };
const post = (body: unknown) =>
  POST(new Request('http://x/api/compose/chat', { method: 'POST', body: JSON.stringify(body) }) as never) as unknown as Promise<R>;
const ask = (content: string) => ({ messages: [{ role: 'user', content }] });

beforeEach(() => {
  st.rl = true; st.balance = 100; st.ai = true;
  st.llm.mockReset(); st.charge.mockClear(); st.refund.mockClear();
});

describe('POST /api/compose/chat', () => {
  it('returns the post, a clamped length and known platforms, and charges the Write-it-for-me price', async () => {
    st.llm.mockResolvedValue(JSON.stringify({ reply: 'Here you go.', post: 'Fresh butter croissants, warm from 7am.', durationSec: 25, platforms: ['Instagram', 'myspace'] }));
    const r = await post(ask('a 15s video for my bakery’s new croissant, warm tone, for Instagram'));
    expect(r).toMatchObject({ reply: 'Here you go.', post: 'Fresh butter croissants, warm from 7am.', durationSec: 20, platforms: ['instagram'], ready: true });
    expect(st.charge).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1', credits: priceForCompose({ withTools: false }).credits }));
    expect(st.refund).not.toHaveBeenCalled();
  });

  it('a follow-up question is not ready and carries no post', async () => {
    st.llm.mockResolvedValue(JSON.stringify({ reply: 'What are you selling?', post: null, durationSec: null, platforms: null }));
    const r = await post(ask('make me a video'));
    expect(r).toMatchObject({ reply: 'What are you selling?', ready: false });
    expect(r).not.toHaveProperty('post');
  });

  it('refunds when the model throws or answers garbage', async () => {
    st.llm.mockRejectedValue(new Error('timeout'));
    expect(await post(ask('croissant video'))).toMatchObject({ error: 'chat_failed', status: 502 });
    st.llm.mockResolvedValue('not json');
    expect(await post(ask('croissant video'))).toMatchObject({ error: 'chat_failed', status: 502 });
    expect(st.refund).toHaveBeenCalledTimes(2);
    expect(st.refund).toHaveBeenCalledWith(expect.objectContaining({ ledgerId: 'led_1' }));
  });

  it('402 without charging when the balance is short', async () => {
    st.balance = 0;
    expect(await post(ask('croissant video'))).toMatchObject({ error: 'insufficient_credits', status: 402 });
    expect(st.charge).not.toHaveBeenCalled();
  });

  it('rejects bad bodies, a rate-limited caller and a missing provider without charging', async () => {
    const status = async (b: unknown) => ((await post(b)) as unknown as Response).status;
    expect(await status({ messages: [] })).toBe(400);
    expect(await status(ask('x'.repeat(2_001)))).toBe(400);
    expect(await status({ messages: [{ role: 'assistant', content: 'hi' }] })).toBe(400);
    expect(await status({ messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'hi' })) })).toBe(400);
    st.rl = false;
    expect(await post(ask('hi'))).toMatchObject({ error: 'rate_limited', status: 429 });
    st.rl = true; st.ai = false;
    expect(await post(ask('hi'))).toMatchObject({ error: 'ai_unavailable', status: 503 });
    expect(st.charge).not.toHaveBeenCalled();
  });
});
