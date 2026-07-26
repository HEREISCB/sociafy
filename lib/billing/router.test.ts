import { describe, it, expect, beforeEach, vi } from 'vitest';

const razorpayStub = { name: 'razorpay' as const, currency: 'INR' as const };
const cfg = { razorpay: true };

vi.mock('./providers/razorpay', () => ({ razorpayProvider: () => razorpayStub }));
vi.mock('../env', () => ({ isStubMode: { razorpay: () => !cfg.razorpay } }));

import { providerFor } from './router';

type ProfileLike = Parameters<typeof providerFor>[0];
const base: ProfileLike = {
  paymentProvider: null,
  billingCurrency: null,
  billingCountry: null,
} as ProfileLike;

// Stripe is parked — every customer is charged INR via Razorpay regardless of
// location, so there is no branch that can resolve to anything else.
const CASES: Array<[string, Partial<ProfileLike>]> = [
  ['IN country, no override',        { billingCountry: 'IN' }],
  ['US country, no override',        { billingCountry: 'US' }],
  ['no country at all',              {}],
  ['billingCurrency=INR override',   { billingCountry: 'US', billingCurrency: 'INR' }],
  ['billingCurrency=USD override',   { billingCountry: 'IN', billingCurrency: 'USD' }],
  ['razorpay lock',                  { paymentProvider: 'razorpay', billingCountry: 'US' }],
  // No such row can exist (Stripe never charged anyone), but a stray value
  // must not dead-end the customer's checkout.
  ['stray stripe lock',              { paymentProvider: 'stripe', billingCountry: 'US' }],
  ['stray stripe lock + USD',        { paymentProvider: 'stripe', billingCurrency: 'USD' }],
];

describe('providerFor', () => {
  beforeEach(() => { cfg.razorpay = true; });

  it.each(CASES)('returns the Razorpay provider for %s', (_label, patch) => {
    expect(providerFor({ ...base, ...patch })).toBe(razorpayStub);
  });

  it('never returns a non-Razorpay provider', () => {
    for (const [, patch] of CASES) {
      expect(providerFor({ ...base, ...patch })?.name).toBe('razorpay');
    }
  });

  it('returns null only when Razorpay credentials are missing', () => {
    cfg.razorpay = false;
    for (const [, patch] of CASES) {
      expect(providerFor({ ...base, ...patch })).toBeNull();
    }
  });
});
