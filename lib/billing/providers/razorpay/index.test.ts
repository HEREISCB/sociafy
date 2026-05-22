import { describe, it, expect, beforeEach, vi } from 'vitest';

const subsCreate = vi.fn();
const ordersCreate = vi.fn();

// Stable object returned by every getRazorpay() call so mutations persist.
const _mockRzp = {
  subscriptions: { create: subsCreate },
  orders: { create: ordersCreate },
};

vi.mock('./client', () => ({
  getRazorpay: () => _mockRzp,
  razorpayPlanIdFor: (tier: string) => ({ starter: 'plan_s', pro: 'plan_p', business: 'plan_b' }[tier]),
}));

vi.mock('./customer', () => ({
  ensureRazorpayCustomer: vi.fn().mockResolvedValue('cust_test'),
}));

vi.mock('../../../env', () => ({
  env: {
    razorpay: {
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      webhookSecret: 'whsec',
      planStarter: 'plan_s', planPro: 'plan_p', planBusiness: 'plan_b',
    },
  },
}));

import { razorpayProvider } from './index';

describe('razorpayProvider.startSubscription', () => {
  beforeEach(() => { subsCreate.mockReset(); });

  it('creates a Razorpay subscription on the right plan and returns a modal handoff', async () => {
    subsCreate.mockResolvedValue({ id: 'sub_abc' });

    const handoff = await razorpayProvider().startSubscription({ userId: 'u1', tier: 'pro' });

    expect(subsCreate).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 'plan_p',
      customer_id: 'cust_test',
      total_count: 120,
      notes: expect.objectContaining({ sociafy_user_id: 'u1', tier: 'pro' }),
    }));
    expect(handoff).toMatchObject({
      kind: 'razorpay_modal',
      subscriptionId: 'sub_abc',
      keyId: 'rzp_test_key',
      currency: 'INR',
    });
  });
});

describe('razorpayProvider.startTopUp', () => {
  beforeEach(() => { ordersCreate.mockReset(); });

  it('rejects credits that are not a positive multiple of 1000', async () => {
    await expect(razorpayProvider().startTopUp({ userId: 'u1', credits: 0 })).rejects.toThrow(/multiple of 1000/);
    await expect(razorpayProvider().startTopUp({ userId: 'u1', credits: 1500 })).rejects.toThrow(/multiple of 1000/);
  });

  it('creates a Razorpay Order priced per 1000-credit pack', async () => {
    ordersCreate.mockResolvedValue({ id: 'order_t1' });

    const handoff = await razorpayProvider().startTopUp({ userId: 'u1', credits: 3000 });

    // 3 packs × ₹1,499 = ₹4,497 = 449700 paise
    expect(ordersCreate).toHaveBeenCalledWith(expect.objectContaining({
      amount: 449700,
      currency: 'INR',
      notes: expect.objectContaining({
        sociafy_user_id: 'u1',
        kind: 'topup',
        credits: '3000',
      }),
    }));
    expect(handoff).toMatchObject({
      kind: 'razorpay_modal',
      orderId: 'order_t1',
      amountMinor: 449700,
      currency: 'INR',
    });
  });
});
