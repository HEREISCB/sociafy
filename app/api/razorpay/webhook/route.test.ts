import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../../../../lib/env', () => ({
  env: { razorpay: { webhookSecret: 'whsec_test' } },
  isStubMode: { razorpay: () => false },
}));

const { applyState, grantIdempotent } = vi.hoisted(() => ({
  applyState: vi.fn(),
  grantIdempotent: vi.fn(),
}));
vi.mock('../../../../lib/billing/state', () => ({ applySubscriptionState: applyState }));
vi.mock('../../../../lib/credits/ledger', () => ({ grantIdempotent }));

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

  it('grants top-up credits on payment.captured with notes.kind=topup', async () => {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_t1',
            notes: { sociafy_user_id: 'u1', kind: 'topup', credits: '2000' },
          },
        },
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
