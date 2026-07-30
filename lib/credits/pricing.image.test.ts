import { describe, it, expect } from 'vitest';
import { CREDIT_PRICES, priceForImage } from './pricing';

describe('priceForImage — output pricing is unchanged', () => {
  // Locked to the current numbers so the reference surcharge cannot drift them.
  it('prices every size/quality tier exactly as before', () => {
    expect(priceForImage('1024x1024', 'low')).toEqual({ action: 'image_low_1024', credits: 2, surcharge: 0 });
    expect(priceForImage('1024x1536', 'low')).toEqual({ action: 'image_low_1024', credits: 2, surcharge: 0 });
    expect(priceForImage('1024x1024', 'medium')).toEqual({ action: 'image_medium_1024', credits: 6, surcharge: 0 });
    expect(priceForImage('1536x1024', 'medium')).toEqual({ action: 'image_medium_portrait', credits: 6, surcharge: 0 });
    expect(priceForImage('1024x1024', 'high')).toEqual({ action: 'image_high_1024', credits: 24, surcharge: 0 });
    expect(priceForImage('1024x1536', 'high')).toEqual({ action: 'image_high_portrait', credits: 23, surcharge: 0 });
  });

  it('charges nothing extra for absent, zero or negative reference counts', () => {
    for (const refs of [undefined, 0, -3]) {
      expect(priceForImage('1024x1024', 'medium', refs)).toEqual({
        action: 'image_medium_1024', credits: 6, surcharge: 0,
      });
    }
  });
});

describe('priceForImage — reference-image surcharge', () => {
  const rate = CREDIT_PRICES.image_reference;

  it('is a flat charge per reference image', () => {
    expect(priceForImage('1024x1024', 'medium', 1).surcharge).toBe(rate);
    expect(priceForImage('1024x1024', 'medium', 4).surcharge).toBe(4 * rate);
  });

  // The bug: input image tokens are clamped to 1024–1521 whatever the source
  // resolution, so a 16 MP master cost 64 credits of surcharge for a bill
  // identical to a 1 MP one. Resolution must not be an input to the price.
  it('does not depend on the resolution of the reference', () => {
    // The caller passes a count, so there is no dimension to charge for at all:
    // one 4000×4000 (16 MP) reference and one 1024×1024 (1 MP) are both 1.
    expect(priceForImage('1024x1024', 'medium', 1).credits).toBe(CREDIT_PRICES.image_medium_1024 + rate);
    // GDC's case: 4000×4000 catalogue photo, medium square. 12, not 70.
    expect(priceForImage('1024x1024', 'medium', 1).credits).toBe(12);
  });

  it('adds the surcharge to the output price and reports it separately', () => {
    const p = priceForImage('1024x1024', 'medium', 2);
    expect(p.surcharge).toBe(2 * rate);
    expect(p.credits).toBe(CREDIT_PRICES.image_medium_1024 + 2 * rate);
    // The action key stays the output tier — the ledger row is still one charge.
    expect(p.action).toBe('image_medium_1024');
  });

  it('is independent of size and quality', () => {
    const surcharges = (['low', 'medium', 'high'] as const).flatMap((q) =>
      (['1024x1024', '1536x1024', '1024x1536'] as const).map((s) => priceForImage(s, q, 3).surcharge),
    );
    expect(new Set(surcharges).size).toBe(1);
  });

  it('stays profitable at the assumed provider rate', () => {
    // Worst case 1,521 input image tokens per reference (measured ceiling),
    // assumed at $20 per 1M tokens — 2× the published gpt-image-1 image-input
    // rate. Revenue is $0.012/credit.
    const costPerRef = (1_521 / 1_000_000) * 20;
    expect(rate * 0.012).toBeGreaterThan(costPerRef);
    // …and still profitable if the true rate is double what we assumed.
    expect(rate * 0.012).toBeGreaterThan(costPerRef * 2);
  });
});
