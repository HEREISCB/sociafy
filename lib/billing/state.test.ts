import { describe, it, expect, beforeEach, vi } from 'vitest';

type Update = Record<string, unknown> & { __whereId?: string };
const updates: Update[] = [];

vi.mock('../db', () => {
  return {
    db: () => ({
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: (clause: { __whereId?: string }) => {
            updates.push({ ...vals, __whereId: clause?.__whereId });
            return Promise.resolve();
          },
        }),
      }),
    }),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, val: string) => ({ __whereId: val }),
}));

import { applySubscriptionState } from './state';

describe('applySubscriptionState', () => {
  beforeEach(() => { updates.length = 0; });

  it('writes Razorpay columns when provider=razorpay', async () => {
    await applySubscriptionState({
      userId: 'u1',
      provider: 'razorpay',
      status: 'active',
      tier: 'pro',
      periodEnd: new Date('2026-06-01T00:00:00Z'),
      providerCustomerId: 'cust_abc',
      providerSubscriptionId: 'sub_xyz',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      tier: 'pro',
      subscriptionStatus: 'active',
      paymentProvider: 'razorpay',
      razorpayCustomerId: 'cust_abc',
      razorpaySubscriptionId: 'sub_xyz',
      __whereId: 'u1',
    });
    expect(updates[0].stripeCustomerId).toBeUndefined();
  });

  it('writes Stripe columns when provider=stripe', async () => {
    await applySubscriptionState({
      userId: 'u2',
      provider: 'stripe',
      status: 'active',
      tier: 'starter',
      periodEnd: null,
      providerCustomerId: 'cus_st',
      providerSubscriptionId: 'sub_st',
    });

    expect(updates[0]).toMatchObject({
      paymentProvider: 'stripe',
      stripeCustomerId: 'cus_st',
      stripeSubscriptionId: 'sub_st',
    });
    expect(updates[0].razorpayCustomerId).toBeUndefined();
  });

  it('omits tier when tier=null (status-only update)', async () => {
    await applySubscriptionState({
      userId: 'u3',
      provider: 'razorpay',
      status: 'past_due',
      tier: null,
      periodEnd: null,
    });

    expect(updates[0].tier).toBeUndefined();
    expect(updates[0].subscriptionStatus).toBe('past_due');
  });
});
