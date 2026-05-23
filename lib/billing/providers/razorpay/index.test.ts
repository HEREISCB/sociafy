import { describe, it, expect, beforeEach, vi } from 'vitest';

const subsCreate = vi.fn();
const subsCancel = vi.fn();
const ordersCreate = vi.fn();

// Stable object returned by every getRazorpay() call so mutations persist.
const _mockRzp = {
  subscriptions: { create: subsCreate, cancel: subsCancel },
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

const dbState = {
  profile: {
    razorpaySubscriptionId: null as string | null,
    subscriptionCurrentPeriodEnd: null as Date | null,
  },
};

const updates: Array<{ id: string; vals: Record<string, unknown> }> = [];

vi.mock('../../../db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            razorpaySubscriptionId: dbState.profile.razorpaySubscriptionId,
            subscriptionCurrentPeriodEnd: dbState.profile.subscriptionCurrentPeriodEnd,
            tier: (dbState.profile as Record<string, unknown>).tier,
            creditCycleStart: (dbState.profile as Record<string, unknown>).creditCycleStart,
          }]),
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: (clause: { __whereId: string }) => {
          updates.push({ id: clause.__whereId, vals });
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

vi.mock('drizzle-orm', () => ({ eq: (_c: unknown, v: string) => ({ __whereId: v }) }));

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

describe('razorpayProvider.cancelSubscription', () => {
  beforeEach(() => {
    subsCancel.mockReset();
    dbState.profile = { razorpaySubscriptionId: null, subscriptionCurrentPeriodEnd: null };
  });

  it('throws when there is no active razorpay subscription', async () => {
    await expect(razorpayProvider().cancelSubscription({ userId: 'u1' }))
      .rejects.toThrow(/no active razorpay subscription/);
  });

  it('cancels at cycle end and returns the period_end', async () => {
    const periodEnd = new Date('2026-06-01T00:00:00Z');
    dbState.profile = { razorpaySubscriptionId: 'sub_x', subscriptionCurrentPeriodEnd: periodEnd };
    subsCancel.mockResolvedValue({ id: 'sub_x', status: 'cancelled' });

    const result = await razorpayProvider().cancelSubscription({ userId: 'u1' });

    expect(subsCancel).toHaveBeenCalledWith('sub_x', true);
    expect(result).toEqual({ periodEnd });
  });
});

describe('razorpayProvider.changeTier — upgrade', () => {
  beforeEach(() => {
    ordersCreate.mockReset();
    dbState.profile = { razorpaySubscriptionId: 'sub_old', subscriptionCurrentPeriodEnd: null };
  });

  it('creates an upgrade-diff order and returns an immediate handoff', async () => {
    // Mid-cycle: 15 days remain of a 30-day cycle.
    const now = new Date('2026-05-16T00:00:00Z');
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    dbState.profile = { razorpaySubscriptionId: 'sub_old', subscriptionCurrentPeriodEnd: periodEnd };

    (dbState.profile as Record<string, unknown>).tier = 'starter';
    (dbState.profile as Record<string, unknown>).creditCycleStart = periodStart;

    vi.setSystemTime(now);
    ordersCreate.mockResolvedValue({ id: 'order_up' });

    const result = await razorpayProvider().changeTier({ userId: 'u1', toTier: 'pro' });

    // Starter → Pro: 7999 - 2999 = 5000 INR diff, half cycle remaining → 2500 INR = 250000 paise.
    expect(ordersCreate).toHaveBeenCalledWith(expect.objectContaining({
      amount: 250000,
      currency: 'INR',
      notes: expect.objectContaining({
        sociafy_user_id: 'u1',
        kind: 'upgrade_diff',
        from_tier: 'starter',
        to_tier: 'pro',
        old_sub_id: 'sub_old',
      }),
    }));
    expect(result.kind).toBe('immediate');
    if (result.kind === 'immediate') {
      expect(result.handoff).toMatchObject({
        kind: 'razorpay_modal',
        orderId: 'order_up',
        amountMinor: 250000,
      });
    }

    vi.useRealTimers();
  });

  it('skips the diff order if prorated amount is 0 and just signals immediate', async () => {
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    dbState.profile = { razorpaySubscriptionId: 'sub_old', subscriptionCurrentPeriodEnd: periodEnd };
    (dbState.profile as Record<string, unknown>).tier = 'starter';
    (dbState.profile as Record<string, unknown>).creditCycleStart = periodStart;

    // periodEnd has passed → diff is 0.
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));

    const result = await razorpayProvider().changeTier({ userId: 'u1', toTier: 'pro' });

    expect(ordersCreate).not.toHaveBeenCalled();
    expect(result.kind).toBe('immediate');
    if (result.kind === 'immediate') expect(result.handoff).toBeUndefined();

    vi.useRealTimers();
  });
});

describe('razorpayProvider.changeTier — downgrade', () => {
  beforeEach(() => {
    subsCancel.mockReset();
    updates.length = 0;
    const periodEnd = new Date('2026-06-01T00:00:00Z');
    dbState.profile = { razorpaySubscriptionId: 'sub_old', subscriptionCurrentPeriodEnd: periodEnd };
    (dbState.profile as Record<string, unknown>).tier = 'business';
    (dbState.profile as Record<string, unknown>).creditCycleStart = new Date('2026-05-01T00:00:00Z');
  });

  it('cancels at cycle end and stores pendingTierChange', async () => {
    subsCancel.mockResolvedValue({ id: 'sub_old', status: 'cancelled' });

    const result = await razorpayProvider().changeTier({ userId: 'u1', toTier: 'pro' });

    expect(subsCancel).toHaveBeenCalledWith('sub_old', true);
    expect(updates[0].vals).toMatchObject({
      pendingTierChangeTo: 'pro',
      pendingTierChangeAt: new Date('2026-06-01T00:00:00Z'),
    });
    expect(result).toMatchObject({
      kind: 'scheduled',
      effectiveAt: new Date('2026-06-01T00:00:00Z'),
    });
  });
});
