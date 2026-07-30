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

  it('charges nothing extra for absent, zero or negative megapixels', () => {
    for (const mp of [undefined, 0, -3]) {
      expect(priceForImage('1024x1024', 'medium', mp)).toEqual({
        action: 'image_medium_1024', credits: 6, surcharge: 0,
      });
    }
  });
});

describe('priceForImage — reference-image surcharge', () => {
  const rate = CREDIT_PRICES.image_reference_mp;

  it('is credits-per-megapixel, rounded up', () => {
    expect(priceForImage('1024x1024', 'medium', 1).surcharge).toBe(rate);
    expect(priceForImage('1024x1024', 'medium', 4).surcharge).toBe(4 * rate);
    // A 1024×1024 reference is 1.048 MP: ceil keeps the rounding error ours.
    expect(priceForImage('1024x1024', 'medium', 1.048576).surcharge).toBe(Math.ceil(1.048576 * rate));
    expect(priceForImage('1024x1024', 'medium', 0.1).surcharge).toBe(1);
  });

  it('adds the surcharge to the output price and reports it separately', () => {
    const p = priceForImage('1024x1024', 'medium', 2);
    expect(p.surcharge).toBe(2 * rate);
    expect(p.credits).toBe(CREDIT_PRICES.image_medium_1024 + 2 * rate);
    // The action key stays the output tier — the ledger row is still one charge.
    expect(p.action).toBe('image_medium_1024');
  });

  it('is independent of size and quality', () => {
    const mp = 3.5;
    const surcharges = (['low', 'medium', 'high'] as const).flatMap((q) =>
      (['1024x1024', '1536x1024', '1024x1536'] as const).map((s) => priceForImage(s, q, mp).surcharge),
    );
    expect(new Set(surcharges).size).toBe(1);
  });

  it('stays profitable at the assumed provider rate', () => {
    // ~1,024 input image tokens per MP (measured), assumed at $20 per 1M tokens
    // — 2× the published gpt-image-1 image-input rate. Revenue is $0.012/credit.
    const costPerMp = (1_024 / 1_000_000) * 20;
    expect(rate * 0.012).toBeGreaterThan(costPerMp);
    // …and still profitable if the true rate is double what we assumed.
    expect(rate * 0.012).toBeGreaterThan(costPerMp * 2);
  });
});
