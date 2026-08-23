import { describe, it, expect } from 'vitest';
import { isValidGstin, splitInclusive, stateCodeFromGstin, zohoStateCode, GST_RATE_PCT } from './gst';
import { TIER_PRICING, TOPUP_PRICING } from './pricing';

describe('isValidGstin', () => {
  it('accepts real GSTINs', () => {
    // Public GSTINs with valid mod-36 checksums.
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('29AAGCB7383J1Z4')).toBe(true);
    expect(isValidGstin('09AABCU9603R1ZL')).toBe(true);
  });

  it('is case- and whitespace-tolerant', () => {
    expect(isValidGstin('  27aapfu0939f1zv ')).toBe(true);
  });

  it('rejects a bad checksum — the whole reason this is not a regex', () => {
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false);
    // Transposed digits: shape still valid, checksum is not.
    expect(isValidGstin('27AAPFU9039F1ZV')).toBe(false);
  });

  it('rejects bad shapes and unassigned state codes', () => {
    expect(isValidGstin('')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);      // too short
    expect(isValidGstin('27AAPFU0939F1YV')).toBe(false);     // 14th char must be Z
    expect(isValidGstin('99AAPFU0939F1ZV')).toBe(false);     // no state 99
  });
});

describe('stateCodeFromGstin / zohoStateCode', () => {
  it('reads the state off the GSTIN', () => {
    expect(stateCodeFromGstin('27AAPFU0939F1ZV')).toBe('27');
    expect(zohoStateCode(stateCodeFromGstin('27AAPFU0939F1ZV'))).toBe('MH');
    expect(zohoStateCode('09')).toBe('UP');
  });

  it('returns null rather than guessing', () => {
    expect(stateCodeFromGstin(null)).toBeNull();
    expect(stateCodeFromGstin('99XXXXX0000X1ZX')).toBeNull();
    expect(zohoStateCode(null)).toBeNull();
  });
});

describe('splitInclusive', () => {
  it('never loses a paisa — taxable + tax always equals what was charged', () => {
    const amounts = [
      ...Object.values(TIER_PRICING.INR).map((t) => t.amountMinor),
      TOPUP_PRICING.INR.amountMinor,
      1, 99, 100, 101, 123457, 999999,
    ];
    for (const gross of amounts) {
      const s = splitInclusive(gross);
      expect(s.taxableMinor + s.taxMinor).toBe(gross);
      expect(s.taxMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it('backs 18% out of the headline price', () => {
    // ₹2,999 inclusive → ₹2,541.53 taxable + ₹457.47 GST.
    expect(splitInclusive(299900)).toMatchObject({ taxableMinor: 254153, taxMinor: 45747 });
    expect(splitInclusive(299900).ratePct).toBe(GST_RATE_PCT);
    // ₹1,499 top-up inclusive → ₹1,270.34 + ₹228.66.
    expect(splitInclusive(149900)).toMatchObject({ taxableMinor: 127034, taxMinor: 22866 });
  });

  it('honours a non-default rate', () => {
    expect(splitInclusive(11800, 18).taxableMinor).toBe(10000);
    expect(splitInclusive(10000, 0)).toMatchObject({ taxableMinor: 10000, taxMinor: 0 });
  });
});
