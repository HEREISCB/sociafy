import { describe, it, expect, vi } from 'vitest';

const razorpayStub = { name: 'razorpay' as const, currency: 'INR' as const };
vi.mock('./providers/razorpay', () => ({ razorpayProvider: () => razorpayStub }));

import { providerFor } from './router';

type ProfileLike = Parameters<typeof providerFor>[0];
const base: ProfileLike = {
  paymentProvider: null,
  billingCurrency: null,
  billingCountry: null,
} as ProfileLike;

describe('providerFor', () => {
  it('returns the Razorpay provider for IN country (no override)', () => {
    expect(providerFor({ ...base, billingCountry: 'IN' })).toBe(razorpayStub);
  });

  it('returns null for non-IN country with no override (Stripe coming soon)', () => {
    expect(providerFor({ ...base, billingCountry: 'US' })).toBeNull();
  });

  it('returns Razorpay when billingCurrency=INR override is set', () => {
    expect(providerFor({ ...base, billingCountry: 'US', billingCurrency: 'INR' })).toBe(razorpayStub);
  });

  it('returns null when billingCurrency=USD override is set (Stripe coming soon)', () => {
    expect(providerFor({ ...base, billingCountry: 'IN', billingCurrency: 'USD' })).toBeNull();
  });

  it('respects the lock when paymentProvider=razorpay regardless of country/currency', () => {
    expect(providerFor({ ...base, paymentProvider: 'razorpay', billingCountry: 'US' })).toBe(razorpayStub);
  });

  it('returns null when paymentProvider=stripe lock is set (Stripe not wired)', () => {
    expect(providerFor({ ...base, paymentProvider: 'stripe', billingCountry: 'IN' })).toBeNull();
  });
});
