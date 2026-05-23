import { describe, it, expect } from 'vitest';
import { TIER_PRICING, TOPUP_PRICING, formatPrice } from './pricing';

describe('TIER_PRICING', () => {
  it('has matching shape for both currencies', () => {
    expect(Object.keys(TIER_PRICING.USD)).toEqual(['starter', 'pro', 'business']);
    expect(Object.keys(TIER_PRICING.INR)).toEqual(['starter', 'pro', 'business']);
  });

  it('uses correct minor units for INR (paise)', () => {
    expect(TIER_PRICING.INR.starter.amountMinor).toBe(299900);
    expect(TIER_PRICING.INR.pro.amountMinor).toBe(799900);
    expect(TIER_PRICING.INR.business.amountMinor).toBe(2999900);
  });

  it('uses correct minor units for USD (cents)', () => {
    expect(TIER_PRICING.USD.starter.amountMinor).toBe(3000);
    expect(TIER_PRICING.USD.pro.amountMinor).toBe(8000);
    expect(TIER_PRICING.USD.business.amountMinor).toBe(29900);
  });
});

describe('TOPUP_PRICING', () => {
  it('is ₹1,499 / 1,000 credits for INR', () => {
    expect(TOPUP_PRICING.INR.amountMinor).toBe(149900);
    expect(TOPUP_PRICING.INR.credits).toBe(1000);
  });

  it('is $15 / 1,000 credits for USD', () => {
    expect(TOPUP_PRICING.USD.amountMinor).toBe(1500);
    expect(TOPUP_PRICING.USD.credits).toBe(1000);
  });
});

describe('formatPrice', () => {
  it('returns ₹-prefixed display string for INR', () => {
    expect(formatPrice('INR', 'starter')).toBe('₹2,999');
    expect(formatPrice('INR', 'pro')).toBe('₹7,999');
    expect(formatPrice('INR', 'business')).toBe('₹29,999');
  });

  it('returns $-prefixed display string for USD', () => {
    expect(formatPrice('USD', 'starter')).toBe('$30');
    expect(formatPrice('USD', 'pro')).toBe('$80');
    expect(formatPrice('USD', 'business')).toBe('$299');
  });
});
