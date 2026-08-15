import { describe, it, expect, beforeEach, vi } from 'vitest';

type Update = Record<string, unknown> & { __whereId?: string; __guard?: unknown };
const updates: Update[] = [];

vi.mock('../db', () => {
  return {
    db: () => ({
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: (clause: { __whereId?: string; __guard?: unknown }) => {
            updates.push({ ...vals, __whereId: clause?.__whereId, __guard: clause?.__guard });
            return Promise.resolve();
          },
        }),
      }),
    }),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: string) => ({ __whereId: val, __col: col }),
  isNull: (col: unknown) => ({ __isNull: col }),
  or: (...parts: unknown[]) => ({ __or: parts }),
  // The id predicate stays readable as __whereId; the identity guard rides along.
  and: (...parts: Array<{ __whereId?: string }>) => ({
    __whereId: parts[0]?.__whereId,
    __guard: parts[1],
  }),
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

  it('guards a status-only update on the subscription id it names', async () => {
    await applySubscriptionState({
      userId: 'u4',
      provider: 'razorpay',
      status: 'canceled',
      tier: null,
      periodEnd: null,
      providerSubscriptionId: 'sub_old',
    });
    // WHERE id = u4 AND (razorpay_subscription_id IS NULL OR = sub_old) — so a
    // cancelled event for a superseded subscription matches zero rows.
    expect(updates[0].__whereId).toBe('u4');
    expect(updates[0].__guard).toBeDefined();
  });

  it('does not guard a tier-carrying write (first activation / upgrade / resubscribe)', async () => {
    await applySubscriptionState({
      userId: 'u5',
      provider: 'razorpay',
      status: 'active',
      tier: 'pro',
      periodEnd: null,
      providerSubscriptionId: 'sub_new',
    });
    expect(updates[0].__whereId).toBe('u5');
    expect(updates[0].__guard).toBeUndefined();
  });
});
