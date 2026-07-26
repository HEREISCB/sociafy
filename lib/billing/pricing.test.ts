import { describe, it, expect } from 'vitest';
import {
  TIER_PRICING, TOPUP_PRICING, INR_PER_USD,
  tierPriceView, topupPriceView, topupLabel,
} from './pricing';

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

  // Parked: still read by the dormant Stripe provider, never rendered.
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

describe('tierPriceView', () => {
  it('shows plain rupees in India, with no approximation', () => {
    expect(tierPriceView('INR', 'starter')).toMatchObject({
      display: '₹2,999', charge: '₹2,999', chargeMinor: 299900, approximate: false,
    });
    expect(tierPriceView('INR', 'business').display).toBe('₹29,999');
  });

  it('derives the non-India figure from the INR amount, not TIER_PRICING.USD', () => {
    const v = tierPriceView('USD', 'starter');
    expect(v.approximate).toBe(true);
    expect(v.display).toBe(`≈$${Math.round(299900 / 100 / INR_PER_USD)}`);
    // The separate USD price point must never be what we show.
    expect(v.display).not.toContain('30');
  });

  it('charges the identical INR amount in both currencies', () => {
    for (const tier of ['starter', 'pro', 'business'] as const) {
      const inr = tierPriceView('INR', tier);
      const usd = tierPriceView('USD', tier);
      expect(usd.chargeMinor).toBe(inr.chargeMinor);
      expect(usd.charge).toBe(inr.charge);
      expect(usd.charge).toBe(TIER_PRICING.INR[tier].priceMonthly);
    }
  });

  it('never shows a bare approximation lower than the rupee charge implies', () => {
    // A low INR_PER_USD keeps the shown dollar figure at or above the true
    // conversion, so we never advertise less than we bill.
    const v = tierPriceView('USD', 'pro');
    expect(v.displayMajor).toBeGreaterThanOrEqual(799900 / 100 / 90);
  });
});

describe('topupPriceView', () => {
  it('shows rupees in India and an approximation elsewhere, same charge', () => {
    expect(topupPriceView('INR')).toMatchObject({ display: '₹1,499', charge: '₹1,499', chargeMinor: 149900 });
    const usd = topupPriceView('USD');
    expect(usd.approximate).toBe(true);
    expect(usd.display).toBe(`≈$${Math.round(149900 / 100 / INR_PER_USD)}`);
    expect(usd.chargeMinor).toBe(149900);
    expect(usd.charge).toBe('₹1,499');
  });

  it('scales by pack for multi-pack purchases in both currencies', () => {
    expect(topupPriceView('INR', 5000).chargeMinor).toBe(149900 * 5);
    expect(topupPriceView('USD', 5000).chargeMinor).toBe(149900 * 5);
    expect(topupPriceView('USD', 5000).charge).toBe(topupPriceView('INR', 5000).charge);
  });

  it('labels the pack size', () => {
    expect(topupLabel('INR')).toBe('₹1,499 / 1,000 credits');
    expect(topupLabel('USD')).toMatch(/^≈\$\d+ \/ 1,000 credits$/);
  });
});
