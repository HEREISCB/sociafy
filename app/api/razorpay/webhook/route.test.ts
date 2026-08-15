import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../../../../lib/env', () => ({
  env: { razorpay: { webhookSecret: 'whsec_test', planStarter: 'plan_s', planPro: 'plan_p', planBusiness: 'plan_b' } },
  isStubMode: { razorpay: () => false },
}));

const { applyState, grantIdempotent, subsCreate, subsCancel, ordersFetch, profileRow, updates } = vi.hoisted(() => {
  return {
    applyState: vi.fn(),
    grantIdempotent: vi.fn(),
    subsCreate: vi.fn(),
    subsCancel: vi.fn(),
    ordersFetch: vi.fn(),
    profileRow: { tier: undefined as string | undefined, razorpayCustomerId: undefined as string | undefined, pendingTierChangeTo: null as string | null },
    updates: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('../../../../lib/billing/state', () => ({ applySubscriptionState: applyState }));
vi.mock('../../../../lib/credits/ledger', () => ({ grantIdempotent }));

vi.mock('../../../../lib/billing/providers/razorpay/client', () => ({
  // payment.captured reads the ORDER back — the payment's own notes are
  // attacker-controlled (see replay-order.audit.test.ts).
  getRazorpay: () => ({
    subscriptions: { create: subsCreate, cancel: subsCancel },
    orders: { fetch: ordersFetch },
  }),
  razorpayPlanIdFor: (tier: string) => ({ starter: 'plan_s', pro: 'plan_p', business: 'plan_b' }[tier]),
}));

vi.mock('../../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([profileRow]) }) }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({ where: () => { updates.push(vals); return Promise.resolve(); } }),
    }),
  }),
}));

vi.mock('drizzle-orm', () => ({ eq: (_c: unknown, v: string) => ({ __whereId: v }) }));

import { POST } from './route';

function sign(body: string): string {
  return crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex');
}

function makeReq(body: string, sig: string) {
  return new Request('http://test/api/razorpay/webhook', {
    method: 'POST',
    headers: { 'x-razorpay-signature': sig },
    body,
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/razorpay/webhook', () => {
  beforeEach(() => {
    applyState.mockReset();
    grantIdempotent.mockReset();
  });

  it('rejects requests with a bad signature (400)', async () => {
    const body = JSON.stringify({ event: 'subscription.activated' });
    const res = await POST(makeReq(body, 'wrong_sig'));
    expect(res.status).toBe(400);
  });

  it('grants credits on subscription.activated (idempotent on event id)', async () => {
    const body = JSON.stringify({
      event: 'subscription.activated',
      payload: {
        subscription: {
          entity: {
            id: 'sub_x', status: 'active', plan_id: 'plan_p',
            current_end: Math.floor(new Date('2026-06-01').getTime() / 1000),
            notes: { sociafy_user_id: 'u1', tier: 'pro' },
            customer_id: 'cust_a',
          },
        },
      },
    });
    grantIdempotent.mockResolvedValue(true);

    const res = await POST(makeReq(body, sign(body)));

    expect(res.status).toBe(200);
    expect(applyState).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      provider: 'razorpay',
      status: 'active',
      tier: 'pro',
      providerCustomerId: 'cust_a',
      providerSubscriptionId: 'sub_x',
    }));
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      kind: 'monthly_grant',
      credits: 6000,
      source: 'rzp_sub:sub_x:activated',
    }));
  });

  it('grants top-up credits on payment.captured for a topup order', async () => {
    // 2,000 credits = 2 packs = 2 x Rs 1,499.
    ordersFetch.mockResolvedValue({
      id: 'order_t1', amount: 299800,
      notes: { sociafy_user_id: 'u1', kind: 'topup', credits: '2000' },
    });
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_t1', amount: 299800, order_id: 'order_t1' } },
      },
    });
    grantIdempotent.mockResolvedValue(true);

    const res = await POST(makeReq(body, sign(body)));

    expect(res.status).toBe(200);
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      kind: 'topup',
      credits: 2000,
      source: 'rzp_topup:pay_t1',
    }));
  });

  it('returns 200 for unhandled events without DB writes', async () => {
    const body = JSON.stringify({ event: 'refund.created', payload: {} });
    const res = await POST(makeReq(body, sign(body)));
    expect(res.status).toBe(200);
    expect(applyState).not.toHaveBeenCalled();
    expect(grantIdempotent).not.toHaveBeenCalled();
  });
});

describe('payment.captured with notes.kind=upgrade_diff', () => {
  beforeEach(() => {
    subsCreate.mockReset();
    subsCancel.mockReset();
    ordersFetch.mockReset();
    grantIdempotent.mockReset();
    applyState.mockReset();
    profileRow.razorpayCustomerId = 'cust_x';
    profileRow.tier = 'starter';
    profileRow.pendingTierChangeTo = null;
    updates.length = 0;
  });

  it('cancels the old sub, creates a new sub on the target plan, and grants the delta', async () => {
    subsCreate.mockResolvedValue({ id: 'sub_new', status: 'active', plan_id: 'plan_p' });
    grantIdempotent.mockResolvedValue(true);
    ordersFetch.mockResolvedValue({
      id: 'order_up1', amount: 500000,
      notes: {
        sociafy_user_id: 'u1',
        kind: 'upgrade_diff',
        from_tier: 'starter',
        to_tier: 'pro',
        old_sub_id: 'sub_old',
      },
    });

    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_up1', amount: 500000, order_id: 'order_up1' } },
      },
    });

    const res = await POST(makeReq(body, sign(body)));
    expect(res.status).toBe(200);
    expect(subsCancel).toHaveBeenCalledWith('sub_old', false);
    expect(subsCreate).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 'plan_p',
      customer_id: 'cust_x',
      notes: expect.objectContaining({ sociafy_user_id: 'u1', tier: 'pro' }),
    }));
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'monthly_grant',
      credits: 4000,
      source: 'rzp_upgrade:pay_up1',
    }));
  });
});

describe('subscription.completed with a pending downgrade', () => {
  beforeEach(() => {
    subsCreate.mockReset();
    grantIdempotent.mockReset();
    updates.length = 0;
    profileRow.razorpayCustomerId = 'cust_x';
    profileRow.pendingTierChangeTo = 'pro';
  });

  it('creates a new sub on the pending plan and clears the pending flag', async () => {
    subsCreate.mockResolvedValue({ id: 'sub_next', status: 'active', plan_id: 'plan_p' });

    const body = JSON.stringify({
      event: 'subscription.completed',
      payload: { subscription: { entity: {
        id: 'sub_done', status: 'completed', plan_id: 'plan_b',
        notes: { sociafy_user_id: 'u1', tier: 'business' },
      } } },
    });

    const res = await POST(makeReq(body, sign(body)));
    expect(res.status).toBe(200);
    expect(subsCreate).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 'plan_p',
      customer_id: 'cust_x',
      notes: expect.objectContaining({ sociafy_user_id: 'u1', tier: 'pro' }),
    }));
    const clearUpdate = updates.find((u) => u.pendingTierChangeTo === null);
    expect(clearUpdate).toBeDefined();
  });
});
