import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../lib/env', () => ({
  env: { stripe: { webhookSecret: 'whsec_test' } },
  isStubMode: { stripe: () => false },
}));

const { applyState, grantIdempotent, subsRetrieve, constructEvent, profileRow, updates, inserts } = vi.hoisted(() => ({
  applyState: vi.fn(),
  grantIdempotent: vi.fn(),
  subsRetrieve: vi.fn(),
  constructEvent: vi.fn(),
  profileRow: {
    id: 'u1' as string | undefined,
    tier: 'starter' as string | undefined,
    pendingTierChangeTo: null as string | null,
  },
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../lib/billing/state', () => ({ applySubscriptionState: applyState }));
vi.mock('../../../../lib/credits/ledger', () => ({ grantIdempotent }));

vi.mock('../../../../lib/stripe', () => ({
  getStripe: () => ({
    webhooks: { constructEvent },
    subscriptions: { retrieve: subsRetrieve },
    customers: { retrieve: vi.fn() },
  }),
  tierForPriceId: (id?: string | null) =>
    ({ price_s: 'starter', price_p: 'pro', price_b: 'business' }[id ?? ''] ?? null),
}));

vi.mock('../../../../lib/db', () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([profileRow]) }) }) }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({ where: () => { updates.push(vals); return Promise.resolve(); } }),
    }),
    insert: () => ({ values: (vals: Record<string, unknown>) => { inserts.push(vals); return Promise.resolve(); } }),
  }),
}));

vi.mock('drizzle-orm', () => ({ eq: (_c: unknown, v: string) => ({ __whereId: v }) }));

import { POST } from './route';

/** Signature verification is mocked at constructEvent; the request body is
 *  irrelevant to these tests, only the event we hand back matters. */
function post(event: unknown) {
  constructEvent.mockReturnValue(event);
  const req = new Request('http://test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=deadbeef' },
    body: '{}',
  });
  return POST(req as unknown as import('next/server').NextRequest);
}

function subOnPrice(priceId: string) {
  return {
    id: 'sub_1',
    status: 'active',
    current_period_end: Math.floor(new Date('2026-09-01').getTime() / 1000),
    items: { data: [{ id: 'si_1', price: { id: priceId } }] },
  };
}

beforeEach(() => {
  applyState.mockReset();
  grantIdempotent.mockReset().mockResolvedValue(true);
  subsRetrieve.mockReset();
  constructEvent.mockReset();
  updates.length = 0;
  inserts.length = 0;
  profileRow.tier = 'starter';
  profileRow.pendingTierChangeTo = null;
});

describe('signature', () => {
  it('rejects a bad signature without touching the db', async () => {
    constructEvent.mockImplementation(() => { throw new Error('no match'); });
    const res = await POST(new Request('http://test', {
      method: 'POST', headers: { 'stripe-signature': 'bad' }, body: '{}',
    }) as unknown as import('next/server').NextRequest);
    expect(res.status).toBe(400);
    expect(grantIdempotent).not.toHaveBeenCalled();
  });

  it('rejects a missing signature', async () => {
    const res = await POST(new Request('http://test', { method: 'POST', body: '{}' }) as unknown as import('next/server').NextRequest);
    expect(res.status).toBe(400);
  });
});

describe('top-up checkout (mode: payment)', () => {
  const topupSession = {
    id: 'cs_top1',
    payment_status: 'paid',
    payment_intent: 'pi_1',
    customer: 'cus_1',
    metadata: { sociafy_user_id: 'u1', kind: 'topup', credits: '3000' },
  };

  it('grants exactly the metadata credits as a topup', async () => {
    const res = await post({ id: 'evt_1', type: 'checkout.session.completed', data: { object: topupSession } });

    expect(res.status).toBe(200);
    expect(grantIdempotent).toHaveBeenCalledTimes(1);
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      kind: 'topup',
      credits: 3000,
      source: 'stripe_topup:cs_top1',
    }));
    // A top-up must not move tier, cycle anchor, or subscription state.
    expect(applyState).not.toHaveBeenCalled();
    expect(subsRetrieve).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('is idempotent across a duplicated delivery — same source key both times', async () => {
    await post({ id: 'evt_1', type: 'checkout.session.completed', data: { object: topupSession } });
    // Stripe retries with a NEW event id; the session id is what dedupes.
    await post({ id: 'evt_2', type: 'checkout.session.async_payment_succeeded', data: { object: topupSession } });

    const sources = grantIdempotent.mock.calls.map((c) => c[0].source);
    expect(sources).toEqual(['stripe_topup:cs_top1', 'stripe_topup:cs_top1']);
  });

  it('does not grant while the payment is still unpaid', async () => {
    await post({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { ...topupSession, payment_status: 'unpaid' } },
    });
    expect(grantIdempotent).not.toHaveBeenCalled();
  });

  it('does not grant when the credits metadata is missing', async () => {
    await post({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { ...topupSession, metadata: { sociafy_user_id: 'u1', kind: 'topup' } } },
    });
    expect(grantIdempotent).not.toHaveBeenCalled();
  });
});

describe('subscription checkout', () => {
  it('grants the full tier allocation keyed on the session id', async () => {
    subsRetrieve.mockResolvedValue(subOnPrice('price_p'));
    const res = await post({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_sub1', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1',
        metadata: { sociafy_user_id: 'u1', kind: 'subscription', tier: 'pro' },
      } },
    });

    expect(res.status).toBe(200);
    expect(applyState).toHaveBeenCalledWith(expect.objectContaining({ tier: 'pro', provider: 'stripe', status: 'active' }));
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'monthly_grant', credits: 6000, source: 'stripe_checkout:cs_sub1',
    }));
  });
});

describe('invoice.paid', () => {
  function invoice(billingReason: string, extra: Record<string, unknown> = {}) {
    return {
      id: 'in_1',
      customer: 'cus_1',
      billing_reason: billingReason,
      parent: { subscription_details: { subscription: 'sub_1' } },
      lines: { data: [] },
      ...extra,
    };
  }

  it('grants a full month on a genuine renewal and resets the cycle anchor', async () => {
    subsRetrieve.mockResolvedValue(subOnPrice('price_p'));
    await post({ id: 'evt_1', type: 'invoice.paid', data: { object: invoice('subscription_cycle') } });

    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'monthly_grant', credits: 6000, source: 'invoice:in_1',
      meta: expect.objectContaining({ reason: 'monthly_renewal' }),
    }));
    expect(updates.some((u) => 'creditCycleStart' in u)).toBe(true);
  });

  it('still finds the subscription on a pre-basil payload (root subscription field)', async () => {
    subsRetrieve.mockResolvedValue(subOnPrice('price_s'));
    await post({ id: 'evt_1', type: 'invoice.paid', data: { object: {
      id: 'in_legacy', customer: 'cus_1', billing_reason: 'subscription_cycle',
      subscription: 'sub_1', lines: { data: [] },
    } } });

    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({ credits: 2000, source: 'invoice:in_legacy' }));
  });

  it('grants only the delta on an upgrade proration, using the invoice lines for the old tier', async () => {
    subsRetrieve.mockResolvedValue(subOnPrice('price_b'));
    // The mirrored column already says business — customer.subscription.updated
    // landed first — so the delta must come from the invoice's credit line.
    profileRow.tier = 'business';
    await post({ id: 'evt_1', type: 'invoice.paid', data: { object: invoice('subscription_update', {
      lines: { data: [
        { amount: -1500, pricing: { price_details: { price: 'price_p' } } },
        { amount: 25000, pricing: { price_details: { price: 'price_b' } } },
      ] },
    }) } });

    expect(grantIdempotent).toHaveBeenCalledTimes(1);
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'monthly_grant',
      credits: 25000 - 6000,
      source: 'stripe_upgrade:in_1',
      meta: expect.objectContaining({ reason: 'upgrade_delta', fromTier: 'pro', toTier: 'business' }),
    }));
    // A proration doesn't move the billing anchor.
    expect(updates.some((u) => 'creditCycleStart' in u)).toBe(false);
  });

  it('falls back to the mirrored tier when the invoice lines are unhelpful', async () => {
    subsRetrieve.mockResolvedValue(subOnPrice('price_p'));
    profileRow.tier = 'starter';
    await post({ id: 'evt_1', type: 'invoice.paid', data: { object: invoice('subscription_update') } });

    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({ credits: 6000 - 2000 }));
  });

  it('grants nothing on a downgrade proration', async () => {
    subsRetrieve.mockResolvedValue(subOnPrice('price_s'));
    profileRow.tier = 'pro';
    await post({ id: 'evt_1', type: 'invoice.paid', data: { object: invoice('subscription_update') } });

    expect(grantIdempotent).not.toHaveBeenCalled();
    expect(applyState).toHaveBeenCalledWith(expect.objectContaining({ tier: 'starter' }));
  });

  it('skips the first invoice of a new subscription (checkout already granted)', async () => {
    await post({ id: 'evt_1', type: 'invoice.paid', data: { object: invoice('subscription_create') } });
    expect(grantIdempotent).not.toHaveBeenCalled();
    expect(applyState).not.toHaveBeenCalled();
  });

  it('mirrors state but grants nothing for other billing reasons', async () => {
    subsRetrieve.mockResolvedValue(subOnPrice('price_p'));
    await post({ id: 'evt_1', type: 'invoice.paid', data: { object: invoice('manual') } });
    expect(applyState).toHaveBeenCalled();
    expect(grantIdempotent).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.updated', () => {
  it('clears the pending tier change once the live price matches it', async () => {
    profileRow.pendingTierChangeTo = 'starter';
    await post({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: {
      ...subOnPrice('price_s'), customer: 'cus_1',
    } } });

    expect(updates.some((u) => u.pendingTierChangeTo === null && u.pendingTierChangeAt === null)).toBe(true);
  });

  it('leaves the pending tier change alone while the old price is still live', async () => {
    profileRow.pendingTierChangeTo = 'starter';
    await post({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: {
      ...subOnPrice('price_p'), customer: 'cus_1',
    } } });

    expect(updates.some((u) => u.pendingTierChangeTo === null)).toBe(false);
  });
});
