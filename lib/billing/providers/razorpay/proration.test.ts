import { describe, it, expect } from 'vitest';
import { proratedDiffMinor, deltaCredits } from './proration';

describe('proratedDiffMinor', () => {
  it('returns full upgrade diff at start of cycle (30 days remaining of 30)', () => {
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    const now         = new Date('2026-05-01T00:00:00Z');
    expect(proratedDiffMinor({
      oldAmountMinor: 299900,
      newAmountMinor: 799900,
      now, periodStart, periodEnd,
    })).toBe(500000);
  });

  it('returns half the diff at mid-cycle (15 days remaining of 30)', () => {
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    const now         = new Date('2026-05-16T00:00:00Z');
    const result = proratedDiffMinor({
      oldAmountMinor: 299900,
      newAmountMinor: 799900,
      now, periodStart, periodEnd,
    });
    expect(result).toBe(250000);
  });

  it('returns 0 when periodEnd has already passed', () => {
    const now         = new Date('2026-06-01T00:00:00Z');
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    expect(proratedDiffMinor({
      oldAmountMinor: 299900,
      newAmountMinor: 799900,
      now, periodStart, periodEnd,
    })).toBe(0);
  });

  it('returns 0 when downgrading (negative diff clamped)', () => {
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    const now         = new Date('2026-05-01T00:00:00Z');
    expect(proratedDiffMinor({
      oldAmountMinor: 799900,
      newAmountMinor: 299900,
      now, periodStart, periodEnd,
    })).toBe(0);
  });

  it('floors to the nearest paise/cent', () => {
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    const now         = new Date('2026-05-24T00:00:00Z');
    expect(proratedDiffMinor({
      oldAmountMinor: 299900,
      newAmountMinor: 799900,
      now, periodStart, periodEnd,
    })).toBe(116666);
  });
});

describe('deltaCredits', () => {
  it('returns the credit gap between tiers', () => {
    expect(deltaCredits('starter', 'pro')).toBe(4000);
    expect(deltaCredits('pro', 'business')).toBe(19000);
    expect(deltaCredits('starter', 'business')).toBe(23000);
  });

  it('returns 0 or negative for same-tier or downgrade (callers should not grant)', () => {
    expect(deltaCredits('pro', 'pro')).toBe(0);
    expect(deltaCredits('business', 'pro')).toBe(-19000);
  });
});
