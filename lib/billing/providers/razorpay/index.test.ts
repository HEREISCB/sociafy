import { describe, it, expect, beforeEach, vi } from 'vitest';

const subsCreate = vi.fn();
vi.mock('./client', () => ({
  getRazorpay: () => ({ subscriptions: { create: subsCreate } }),
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
