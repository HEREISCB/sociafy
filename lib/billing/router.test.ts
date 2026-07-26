import { describe, it, expect, vi, beforeEach } from 'vitest';

const razorpayStub = { name: 'razorpay' as const, currency: 'INR' as const };
const stripeStub = { name: 'stripe' as const, currency: 'USD' as const };
const cfg = { stripe: true };

vi.mock('./providers/razorpay', () => ({ razorpayProvider: () => razorpayStub }));
vi.mock('./providers/stripe', () => ({
  stripeProvider: () => stripeStub,
  stripeConfigured: () => cfg.stripe,
}));

import { providerFor } from './router';

type ProfileLike = Parameters<typeof providerFor>[0];
const base: ProfileLike = {
  paymentProvider: null,
  billingCurrency: null,
  billingCountry: null,
} as ProfileLike;

describe('providerFor', () => {
  beforeEach(() => { cfg.stripe = true; });

  it('returns the Razorpay provider for IN country (no override)', () => {
    expect(providerFor({ ...base, billingCountry: 'IN' })).toBe(razorpayStub);
  });

  it('returns the Stripe provider for non-IN country with no override', () => {
    expect(providerFor({ ...base, billingCountry: 'US' })).toBe(stripeStub);
  });

  it('returns Razorpay when billingCurrency=INR override is set', () => {
    expect(providerFor({ ...base, billingCountry: 'US', billingCurrency: 'INR' })).toBe(razorpayStub);
  });

  it('returns Stripe when billingCurrency=USD override is set', () => {
    expect(providerFor({ ...base, billingCountry: 'IN', billingCurrency: 'USD' })).toBe(stripeStub);
  });

  it('respects the lock when paymentProvider=razorpay regardless of country/currency', () => {
    expect(providerFor({ ...base, paymentProvider: 'razorpay', billingCountry: 'US' })).toBe(razorpayStub);
  });

  it('respects the lock when paymentProvider=stripe regardless of country/currency', () => {
    expect(providerFor({ ...base, paymentProvider: 'stripe', billingCountry: 'IN' })).toBe(stripeStub);
  });

  it('returns null when Stripe is the resolved provider but has no credentials', () => {
    cfg.stripe = false;
    expect(providerFor({ ...base, billingCountry: 'US' })).toBeNull();
    expect(providerFor({ ...base, paymentProvider: 'stripe' })).toBeNull();
  });
});
