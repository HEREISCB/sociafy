/**
 * Razorpay webhook — stale-replay and paid-amount regressions.
 *
 * Was an audit artifact for two money bugs, now the test that keeps them fixed:
 *
 * 1. `applySubscriptionState` was a blind last-writer-wins UPDATE, so the
 *    `subscription.cancelled` event for the subscription an upgrade had just
 *    superseded wiped the plan the customer had paid for. It now carries an
 *    identity guard in its WHERE clause.
 * 2. `payment.captured` trusted `payment.entity.notes` for the recipient AND the
 *    credit quantity — the same object `startTopUp` hands to the browser, which
 *    passes it into the Razorpay Checkout constructor — and never looked at the
 *    amount. It now reads the order back from Razorpay and prices it.
 *
 * `lib/billing/state.ts` is deliberately NOT mocked here: the guard lives in the
 * UPDATE's WHERE clause, so the fake profile below only accepts writes whose
 * predicate actually matches it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../../../../lib/env', () => ({
  env: { razorpay: { webhookSecret: 'whsec_test', planStarter: 'plan_s', planPro: 'plan_p', planBusiness: 'plan_b' } },
  isStubMode: { razorpay: () => false },
}));

const { grantIdempotent, subsCreate, subsCancel, ordersFetch, profileRow, rejectedUpdates } = vi.hoisted(() => ({
  grantIdempotent: vi.fn(),
  subsCreate: vi.fn(),
  subsCancel: vi.fn(),
  ordersFetch: vi.fn(),
  profileRow: {
    id: 'u1',
    tier: 'starter' as string,
    subscription_status: null as string | null,
    razorpay_subscription_id: null as string | null,
    razorpayCustomerId: 'cust_x',
    pendingTierChangeTo: null as string | null,
  },
  /** Updates whose WHERE matched nothing — i.e. events the guard rejected. */
  rejectedUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../lib/credits/ledger', () => ({ grantIdempotent }));
vi.mock('../../../../lib/billing/providers/razorpay/client', () => ({
  getRazorpay: () => ({
    subscriptions: { create: subsCreate, cancel: subsCancel },
    orders: { fetch: ordersFetch },
  }),
  razorpayPlanIdFor: (t: string) => ({ starter: 'plan_s', pro: 'plan_p', business: 'plan_b' }[t]),
}));

/**
 * Minimal predicate tree + evaluator, so a guarded UPDATE really can miss.
 * Columns are real drizzle columns (lib/db/schema is not mocked), so they carry
 * a snake_case `.name` that indexes straight into the fake row.
 */
type Pred = { op: 'eq'; col: string; val: unknown } | { op: 'isNull'; col: string }
  | { op: 'and' | 'or'; parts: Pred[] };
const colName = (c: unknown) => (c as { name: string }).name;
const evalPred = (p: Pred, row: Record<string, unknown>): boolean => {
  switch (p.op) {
    case 'eq':    return row[p.col] === p.val;
    case 'isNull': return row[p.col] === null || row[p.col] === undefined;
    case 'and':   return p.parts.every((q) => evalPred(q, row));
    case 'or':    return p.parts.some((q) => evalPred(q, row));
  }
};

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown): Pred => ({ op: 'eq', col: colName(col), val }),
  isNull: (col: unknown): Pred => ({ op: 'isNull', col: colName(col) }),
  and: (...parts: Pred[]): Pred => ({ op: 'and', parts }),
  or: (...parts: Pred[]): Pred => ({ op: 'or', parts }),
}));

// Column names the profile fake understands; anything else is ignored on write.
const COL_OF: Record<string, string> = {
  tier: 'tier',
  subscriptionStatus: 'subscription_status',
  razorpaySubscriptionId: 'razorpay_subscription_id',
};

vi.mock('../../../../lib/db', () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([profileRow]) }) }) }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: (pred: Pred) => {
          if (!evalPred(pred, profileRow as unknown as Record<string, unknown>)) {
            rejectedUpdates.push(vals);
            return Promise.resolve();
          }
          for (const [k, v] of Object.entries(vals)) {
            if (COL_OF[k]) (profileRow as Record<string, unknown>)[COL_OF[k]] = v;
          }
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

import { POST } from './route';

const sign = (b: string) => crypto.createHmac('sha256', 'whsec_test').update(b).digest('hex');
const post = (payload: unknown) => {
  const body = JSON.stringify(payload);
  return POST(new Request('http://t/api/razorpay/webhook', {
    method: 'POST', headers: { 'x-razorpay-signature': sign(body) }, body,
  }) as never);
};

const subEvent = (event: string, entity: Record<string, unknown>) =>
  ({ event, payload: { subscription: { entity } } });
const paymentEvent = (entity: Record<string, unknown>) =>
  ({ event: 'payment.captured', payload: { payment: { entity } } });

beforeEach(() => {
  grantIdempotent.mockReset(); subsCreate.mockReset(); subsCancel.mockReset(); ordersFetch.mockReset();
  rejectedUpdates.length = 0;
  Object.assign(profileRow, {
    tier: 'starter', subscription_status: null, razorpay_subscription_id: null,
    razorpayCustomerId: 'cust_x', pendingTierChangeTo: null,
  });
  grantIdempotent.mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('applySubscriptionState identity guard', () => {
  it('keeps the upgrade when the superseded subscription\'s cancelled event arrives', async () => {
    subsCreate.mockResolvedValue({ id: 'sub_new' });
    profileRow.razorpay_subscription_id = 'sub_old';
    ordersFetch.mockResolvedValue({
      id: 'order_up', amount: 50000,
      notes: { sociafy_user_id: 'u1', kind: 'upgrade_diff', from_tier: 'starter', to_tier: 'pro', old_sub_id: 'sub_old' },
    });

    // 1. Upgrade payment lands: old sub cancelled at Razorpay, new sub created.
    await post(paymentEvent({ id: 'pay_1', amount: 50000, order_id: 'order_up' }));
    expect(subsCancel).toHaveBeenCalledWith('sub_old', false);
    expect(profileRow.tier).toBe('pro');
    expect(profileRow.razorpay_subscription_id).toBe('sub_new');

    // 2. Razorpay delivers subscription.cancelled for the OLD sub — the
    //    cancellation we ourselves requested a moment ago.
    await post(subEvent('subscription.cancelled', {
      id: 'sub_old', status: 'cancelled', plan_id: 'plan_s',
      notes: { sociafy_user_id: 'u1', tier: 'starter' },
    }));

    // The customer still has the Pro plan they paid for.
    expect(profileRow.subscription_status).toBe('active');
    expect(profileRow.tier).toBe('pro');
    expect(profileRow.razorpay_subscription_id).toBe('sub_new');
    expect(rejectedUpdates).toHaveLength(1);
  });

  it('still applies a cancellation for the subscription the profile actually holds', async () => {
    profileRow.razorpay_subscription_id = 'sub_a';
    profileRow.subscription_status = 'active';
    await post(subEvent('subscription.cancelled', {
      id: 'sub_a', status: 'cancelled', plan_id: 'plan_p', notes: { sociafy_user_id: 'u1' },
    }));
    expect(profileRow.subscription_status).toBe('canceled');
    expect(rejectedUpdates).toEqual([]);
  });

  it('does not block the first activation, nor a new subscription after cancelling', async () => {
    // First ever subscription: no id on the profile yet.
    await post(subEvent('subscription.activated', {
      id: 'sub_a', status: 'active', plan_id: 'plan_p', current_end: 1800000000,
      notes: { sociafy_user_id: 'u1', tier: 'pro' },
    }));
    expect(profileRow.razorpay_subscription_id).toBe('sub_a');
    expect(profileRow.subscription_status).toBe('active');

    await post(subEvent('subscription.cancelled', {
      id: 'sub_a', status: 'cancelled', plan_id: 'plan_p', notes: { sociafy_user_id: 'u1' },
    }));
    expect(profileRow.subscription_status).toBe('canceled');

    // Re-subscribe: a genuinely different subscription id must still land.
    await post(subEvent('subscription.activated', {
      id: 'sub_b', status: 'active', plan_id: 'plan_b', current_end: 1900000000,
      notes: { sociafy_user_id: 'u1', tier: 'business' },
    }));
    expect(profileRow.razorpay_subscription_id).toBe('sub_b');
    expect(profileRow.subscription_status).toBe('active');
    expect(profileRow.tier).toBe('business');
    expect(rejectedUpdates).toEqual([]);
  });

  it('ignores a status event naming a subscription that is not ours at all', async () => {
    profileRow.razorpay_subscription_id = 'sub_mine';
    profileRow.subscription_status = 'active';
    await post(subEvent('subscription.halted', {
      id: 'sub_someone_else', status: 'halted', plan_id: 'plan_p', notes: { sociafy_user_id: 'u1' },
    }));
    expect(profileRow.subscription_status).toBe('active');
    expect(rejectedUpdates).toHaveLength(1);
  });
});

describe('payment.captured grants from the order, not the payment notes', () => {
  const topupOrder = {
    id: 'order_real', amount: 149900,
    notes: { sociafy_user_id: 'u1', kind: 'topup', credits: '1000' },
  };

  it('grants the ORDER\'s credit count and ignores the notes the browser could forge', async () => {
    ordersFetch.mockResolvedValue(topupOrder);
    await post(paymentEvent({
      id: 'pay_1', amount: 149900, order_id: 'order_real',
      notes: { sociafy_user_id: 'attacker', kind: 'topup', credits: '5000000' },
    }));
    expect(ordersFetch).toHaveBeenCalledWith('order_real');
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'topup', userId: 'u1', credits: 1000, source: 'rzp_topup:pay_1',
    }));
  });

  it('refuses to grant when the paid amount is not the price of those credits', async () => {
    // An order minted outside startTopUp: 100,000 credits for one pack's money.
    ordersFetch.mockResolvedValue({
      id: 'order_cheap', amount: 149900,
      notes: { sociafy_user_id: 'u1', kind: 'topup', credits: '100000' },
    });
    await post(paymentEvent({ id: 'pay_2', amount: 149900, order_id: 'order_cheap' }));
    expect(grantIdempotent).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('refuses a partial capture of a valid order', async () => {
    ordersFetch.mockResolvedValue(topupOrder);
    await post(paymentEvent({ id: 'pay_3', amount: 100, order_id: 'order_real' }));
    expect(grantIdempotent).not.toHaveBeenCalled();
  });

  it('does not grant when the order cannot be fetched', async () => {
    ordersFetch.mockRejectedValue(new Error('razorpay 500'));
    await post(paymentEvent({
      id: 'pay_4', amount: 149900, order_id: 'order_real',
      notes: { sociafy_user_id: 'u1', kind: 'topup', credits: '1000' },
    }));
    expect(grantIdempotent).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('does not grant for a payment with no order behind it', async () => {
    await post(paymentEvent({
      id: 'pay_5', amount: 149900,
      notes: { sociafy_user_id: 'u1', kind: 'topup', credits: '1000' },
    }));
    expect(ordersFetch).not.toHaveBeenCalled();
    expect(grantIdempotent).not.toHaveBeenCalled();
  });

  it('prices a multi-pack top-up off the price table', async () => {
    ordersFetch.mockResolvedValue({
      id: 'order_5k', amount: 149900 * 5,
      notes: { sociafy_user_id: 'u1', kind: 'topup', credits: '5000' },
    });
    await post(paymentEvent({ id: 'pay_6', amount: 149900 * 5, order_id: 'order_5k' }));
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({ credits: 5000, userId: 'u1' }));
  });

  it('keeps the replay-safe source key, so a redelivered payment cannot double-credit', async () => {
    ordersFetch.mockResolvedValue(topupOrder);
    await post(paymentEvent({ id: 'pay_7', amount: 149900, order_id: 'order_real' }));
    grantIdempotent.mockResolvedValue(false); // second call: the ledger dedups it
    await post(paymentEvent({ id: 'pay_7', amount: 149900, order_id: 'order_real' }));
    const sources = grantIdempotent.mock.calls.map((c) => (c[0] as { source: string }).source);
    expect(sources).toEqual(['rzp_topup:pay_7', 'rzp_topup:pay_7']);
  });

  it('takes the upgrade\'s tiers from the order too', async () => {
    subsCreate.mockResolvedValue({ id: 'sub_new' });
    profileRow.razorpay_subscription_id = 'sub_old';
    ordersFetch.mockResolvedValue({
      id: 'order_up', amount: 50000,
      notes: { sociafy_user_id: 'u1', kind: 'upgrade_diff', from_tier: 'starter', to_tier: 'pro', old_sub_id: 'sub_old' },
    });
    await post(paymentEvent({
      id: 'pay_8', amount: 50000, order_id: 'order_up',
      notes: { sociafy_user_id: 'u1', kind: 'upgrade_diff', from_tier: 'starter', to_tier: 'business', old_sub_id: 'sub_old' },
    }));
    // business would have been a bigger credit delta — the order says pro.
    expect(profileRow.tier).toBe('pro');
    expect(subsCreate).toHaveBeenCalledWith(expect.objectContaining({ plan_id: 'plan_p' }));
  });
});
