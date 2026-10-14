import { describe, it, expect, vi, beforeEach } from 'vitest';

const preparePlan = vi.hoisted(() => vi.fn());
const fillPlan = vi.hoisted(() => vi.fn());
const after = vi.hoisted(() => vi.fn());
const updates = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after }));
vi.mock('../../../../lib/agent/run', () => ({ preparePlan, fillPlan }));
vi.mock('../../../../lib/db', () => ({
  db: () => ({ update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }) }),
}));
vi.mock('../../../../lib/api', () => ({
  withUser: async (handler: (u: { id: string }) => unknown) => {
    const r = await handler({ id: 'user_abc' });
    return r instanceof Response ? r : Response.json(r);
  },
}));

import { POST } from './route';

const call = (body: unknown) => POST(new Request('https://sociafy.app/api/plan/generate', { method: 'POST', body: JSON.stringify(body) }) as never);

beforeEach(() => { preparePlan.mockReset(); fillPlan.mockReset(); after.mockReset(); updates.length = 0; });

describe('POST /api/plan/generate', () => {
  it('answers 202 at once and drafts after the response', async () => {
    preparePlan.mockResolvedValue({ ctx: {}, kinds: ['text'], slots: [new Date('2026-03-03T09:00:00Z')] });
    const res = await call({ horizonDays: 30 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'started', planned: 1, slots: [{ at: '2026-03-03T09:00:00.000Z', kind: 'text' }] });
    expect(preparePlan).toHaveBeenCalledWith('user_abc', { horizonDays: 30 });
    expect(updates).toEqual([expect.objectContaining({ planHorizonDays: 30 })]);
    expect(fillPlan).not.toHaveBeenCalled();
    await after.mock.calls[0][0]();
    expect(fillPlan).toHaveBeenCalled();
  });

  it('refuses a second run while one holds the lease', async () => {
    preparePlan.mockResolvedValue({ userId: 'user_abc', drafted: 0, published: 0, held: 0, reason: 'already_running' });
    const res = await call({});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: 'running', reason: 'already_running' });
    expect(after).not.toHaveBeenCalled();
  });

  it('says so when the plan is already full', async () => {
    preparePlan.mockResolvedValue({ userId: 'user_abc', drafted: 0, published: 0, held: 0, reason: 'plan_full' });
    expect(await (await call({})).json()).toEqual({ status: 'full' });
  });

  it('rejects a horizon other than 7 or 30', async () => {
    expect((await call({ horizonDays: 14 })).status).toBe(400);
  });
});
