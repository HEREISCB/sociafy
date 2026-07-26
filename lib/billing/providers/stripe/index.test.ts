import { describe, it, expect, beforeEach, vi } from 'vitest';

const sessionsCreate = vi.fn();
const customersCreate = vi.fn();
const subsRetrieve = vi.fn();
const subsUpdate = vi.fn();
const schedCreate = vi.fn();
const schedRetrieve = vi.fn();
const schedUpdate = vi.fn();

// Stable object returned by every getStripe() call so mutations persist.
const _mockStripe = {
  checkout: { sessions: { create: sessionsCreate } },
  customers: { create: customersCreate },
  subscriptions: { retrieve: subsRetrieve, update: subsUpdate },
  subscriptionSchedules: { create: schedCreate, retrieve: schedRetrieve, update: schedUpdate },
};

const cfg = {
  secretKey: 'sk_test' as string | null,
  prices: { starter: 'price_s', pro: 'price_p', business: 'price_b' } as Record<string, string | null>,
};

vi.mock('../../../stripe', () => ({
  getStripe: () => _mockStripe,
  priceIdFor: (tier: string) => cfg.prices[tier] ?? null,
  tierForPriceId: (id: string | null | undefined) =>
    Object.entries(cfg.prices).find(([, v]) => v === id)?.[0] ?? null,
  ORDERED_TIERS: ['starter', 'pro', 'business'],
}));

vi.mock('./customer', () => ({
  ensureStripeCustomer: vi.fn().mockResolvedValue('cus_test'),
}));

vi.mock('../../../env', () => ({
  env: { appUrl: 'https://app.test', get stripe() { return { secretKey: cfg.secretKey }; } },
  isStubMode: { stripe: () => !cfg.secretKey },
}));

const dbState = {
  profile: {
    stripeSubscriptionId: null as string | null,
    subscriptionCurrentPeriodEnd: null as Date | null,
    tier: 'starter' as string,
  },
};

vi.mock('../../../db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ ...dbState.profile }]) }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  }),
}));

vi.mock('drizzle-orm', () => ({ eq: (_c: unknown, v: string) => ({ __whereId: v }) }));

import { stripeProvider, stripeConfigured } from './index';

beforeEach(() => {
  sessionsCreate.mockReset();
  subsRetrieve.mockReset();
  subsUpdate.mockReset();
  schedCreate.mockReset();
  schedRetrieve.mockReset();
  schedUpdate.mockReset();
  cfg.secretKey = 'sk_test';
  cfg.prices = { starter: 'price_s', pro: 'price_p', business: 'price_b' };
  dbState.profile = { stripeSubscriptionId: null, subscriptionCurrentPeriodEnd: null, tier: 'starter' };
});

describe('stripeConfigured', () => {
  it('is true with a secret key and all three prices', () => {
    expect(stripeConfigured()).toBe(true);
  });

  it('is false without a secret key', () => {
    cfg.secretKey = null;
    expect(stripeConfigured()).toBe(false);
  });

  it('is false when a tier price id is missing', () => {
    cfg.prices.pro = null;
    expect(stripeConfigured()).toBe(false);
  });
});

describe('stripeProvider.startSubscription', () => {
  it('creates a subscription Checkout Session with the webhook metadata and returns a redirect', async () => {
    sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });

    const handoff = await stripeProvider().startSubscription({ userId: 'u1', tier: 'pro' });

    expect(sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'subscription',
      customer: 'cus_test',
      line_items: [{ price: 'price_p', quantity: 1 }],
      client_reference_id: 'u1',
      metadata: expect.objectContaining({ sociafy_user_id: 'u1', tier: 'pro', kind: 'subscription' }),
      subscription_data: { metadata: { sociafy_user_id: 'u1', tier: 'pro' } },
      success_url: 'https://app.test/billing?checkout=success',
      cancel_url: 'https://app.test/billing?checkout=canceled',
    }));
    expect(handoff).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/cs_1' });
  });

  it('throws when the tier has no configured price', async () => {
    cfg.prices.pro = null;
    await expect(stripeProvider().startSubscription({ userId: 'u1', tier: 'pro' }))
      .rejects.toThrow(/STRIPE_PRICE_PRO is not set/);
  });
});

describe('stripeProvider.startTopUp', () => {
  it('rejects credits that are not a positive multiple of 1000', async () => {
    await expect(stripeProvider().startTopUp({ userId: 'u1', credits: 0 })).rejects.toThrow(/multiple of 1000/);
    await expect(stripeProvider().startTopUp({ userId: 'u1', credits: 1500 })).rejects.toThrow(/multiple of 1000/);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('creates a one-off payment session priced per 1000-credit pack', async () => {
    sessionsCreate.mockResolvedValue({ id: 'cs_2', url: 'https://checkout.stripe.com/c/cs_2' });

    const handoff = await stripeProvider().startTopUp({ userId: 'u1', credits: 3000 });

    // 3 packs × $15/pack, charged as quantity 3 of a $15 inline price.
    expect(sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      customer: 'cus_test',
      line_items: [expect.objectContaining({
        quantity: 3,
        price_data: expect.objectContaining({ currency: 'usd', unit_amount: 1500 }),
      })],
      metadata: expect.objectContaining({ sociafy_user_id: 'u1', kind: 'topup', credits: '3000' }),
      payment_intent_data: { metadata: { sociafy_user_id: 'u1', kind: 'topup', credits: '3000' } },
    }));
    expect(handoff).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/cs_2' });
  });
});

describe('stripeProvider.cancelSubscription', () => {
  it('throws when there is no active stripe subscription', async () => {
    await expect(stripeProvider().cancelSubscription({ userId: 'u1' }))
      .rejects.toThrow(/no active stripe subscription/);
  });

  it('cancels at period end and returns the mirrored period_end', async () => {
    const periodEnd = new Date('2026-06-01T00:00:00Z');
    dbState.profile = { stripeSubscriptionId: 'sub_x', subscriptionCurrentPeriodEnd: periodEnd, tier: 'pro' };
    subsUpdate.mockResolvedValue({ id: 'sub_x' });

    const result = await stripeProvider().cancelSubscription({ userId: 'u1' });

    expect(subsUpdate).toHaveBeenCalledWith('sub_x', { cancel_at_period_end: true });
    expect(result).toEqual({ periodEnd });
  });
});

describe('stripeProvider.changeTier', () => {
  const periodStart = Math.floor(new Date('2026-05-01T00:00:00Z').getTime() / 1000);
  const periodEnd = Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000);

  beforeEach(() => {
    dbState.profile = { stripeSubscriptionId: 'sub_x', subscriptionCurrentPeriodEnd: null, tier: 'starter' };
  });

  it('throws when there is no active stripe subscription', async () => {
    dbState.profile.stripeSubscriptionId = null;
    await expect(stripeProvider().changeTier({ userId: 'u1', toTier: 'pro' }))
      .rejects.toThrow(/no active stripe subscription/);
  });

  it('upgrades immediately and lets Stripe invoice the proration', async () => {
    subsRetrieve.mockResolvedValue({
      id: 'sub_x',
      schedule: null,
      items: { data: [{ id: 'si_1', price: { id: 'price_s' } }] },
    });
    subsUpdate.mockResolvedValue({ id: 'sub_x' });

    const result = await stripeProvider().changeTier({ userId: 'u1', toTier: 'pro' });

    expect(subsUpdate).toHaveBeenCalledWith('sub_x', {
      items: [{ id: 'si_1', price: 'price_p' }],
      proration_behavior: 'always_invoice',
    });
    expect(schedCreate).not.toHaveBeenCalled();
    expect(result.kind).toBe('immediate');
  });

  it('rejects a change to the tier the subscription is already on', async () => {
    subsRetrieve.mockResolvedValue({
      id: 'sub_x',
      schedule: null,
      items: { data: [{ id: 'si_1', price: { id: 'price_p' } }] },
    });
    await expect(stripeProvider().changeTier({ userId: 'u1', toTier: 'pro' }))
      .rejects.toThrow(/same as the current tier/);
  });

  it('downgrades via a subscription schedule that flips price at period end', async () => {
    dbState.profile.tier = 'business';
    subsRetrieve.mockResolvedValue({
      id: 'sub_x',
      schedule: null,
      items: { data: [{ id: 'si_1', price: { id: 'price_b' } }] },
    });
    schedCreate.mockResolvedValue({
      id: 'sub_sched_1',
      phases: [{ start_date: periodStart, end_date: periodEnd }],
    });
    schedUpdate.mockResolvedValue({ id: 'sub_sched_1' });

    const result = await stripeProvider().changeTier({ userId: 'u1', toTier: 'pro' });

    expect(schedCreate).toHaveBeenCalledWith({ from_subscription: 'sub_x' });
    expect(schedUpdate).toHaveBeenCalledWith('sub_sched_1', {
      end_behavior: 'release',
      phases: [
        { items: [{ price: 'price_b', quantity: 1 }], start_date: periodStart, end_date: periodEnd },
        { items: [{ price: 'price_p', quantity: 1 }] },
      ],
    });
    expect(subsUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'scheduled', effectiveAt: new Date('2026-06-01T00:00:00Z') });
  });

  it('reuses an existing schedule instead of creating a second one', async () => {
    dbState.profile.tier = 'business';
    subsRetrieve.mockResolvedValue({
      id: 'sub_x',
      schedule: 'sub_sched_1',
      items: { data: [{ id: 'si_1', price: { id: 'price_b' } }] },
    });
    schedRetrieve.mockResolvedValue({
      id: 'sub_sched_1',
      phases: [{ start_date: periodStart, end_date: periodEnd }, { start_date: periodEnd }],
    });

    const result = await stripeProvider().changeTier({ userId: 'u1', toTier: 'starter' });

    expect(schedCreate).not.toHaveBeenCalled();
    expect(schedRetrieve).toHaveBeenCalledWith('sub_sched_1');
    expect(result.kind).toBe('scheduled');
  });
});
