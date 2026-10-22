import { describe, it, expect, beforeEach, vi } from 'vitest';

// POST /api/billing/cancel: records the cancel locally, never calls Razorpay
// twice, and leaves webhook semantics alone.
const state = {
  profile: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  cancelCalls: 0,
  periodEnd: null as Date | null,
};

vi.mock('../../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(state.profile ? [state.profile] : []) }) }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => { state.updates.push(v); return Promise.resolve(); },
      }),
    }),
  }),
}));

vi.mock('../../../../lib/api', () => ({
  withUser: async (handler: (u: { id: string }) => unknown) => {
    const r = await handler({ id: 'user_abc' });
    return r instanceof Response ? r : Response.json(r);
  },
  jsonError: (error: string, status = 400) =>
    new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } }),
}));

vi.mock('../../../../lib/billing/router', () => ({
  providerFor: () => ({
    name: 'razorpay',
    cancelSubscription: async () => { state.cancelCalls++; return { periodEnd: state.periodEnd }; },
  }),
}));

import { POST } from './route';

const END = new Date('2099-11-14T00:00:00Z');
const active = () => ({
  subscriptionStatus: 'active',
  pendingTierChangeTo: null,
  pendingTierChangeAt: null,
  subscriptionCurrentPeriodEnd: END,
  paymentProvider: 'razorpay',
  billingCurrency: 'INR',
  billingCountry: 'IN',
});
const call = async () => {
  const r = await POST(new Request('http://x/api/billing/cancel', { method: 'POST' }) as never);
  return { status: r.status, body: await r.json() };
};

describe('POST /api/billing/cancel', () => {
  beforeEach(() => {
    state.profile = active();
    state.updates = [];
    state.cancelCalls = 0;
    state.periodEnd = END;
  });

  it('cancels at Razorpay once and records "ends at period end"', async () => {
    const r = await call();
    expect(r.body).toEqual({ periodEnd: END.toISOString() });
    expect(state.cancelCalls).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ pendingTierChangeTo: null, pendingTierChangeAt: END });
  });

  it('is idempotent: an already-recorded cancel answers without calling Razorpay', async () => {
    state.profile = { ...active(), pendingTierChangeAt: END };
    const r = await call();
    expect(r.body).toEqual({ periodEnd: END.toISOString() });
    expect(state.cancelCalls).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it('over a pending downgrade: drops the downgrade, keeps the date, no second Razorpay cancel', async () => {
    state.profile = { ...active(), pendingTierChangeTo: 'starter', pendingTierChangeAt: END };
    const r = await call();
    expect(r.body).toEqual({ periodEnd: END.toISOString() });
    expect(state.cancelCalls).toBe(0);
    expect(state.updates[0]).toMatchObject({ pendingTierChangeTo: null, pendingTierChangeAt: END });
  });

  it('writes nothing when Razorpay gives no period end', async () => {
    state.periodEnd = null;
    const r = await call();
    expect(r.body).toEqual({ periodEnd: null });
    expect(state.cancelCalls).toBe(1);
    expect(state.updates).toHaveLength(0);
  });

  it('rejects without an active subscription', async () => {
    state.profile = { ...active(), subscriptionStatus: 'canceled' };
    const r = await call();
    expect(r.status).toBe(400);
    expect(state.cancelCalls).toBe(0);
  });
});
