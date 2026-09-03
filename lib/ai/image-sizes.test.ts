import { describe, expect, it } from 'vitest';
import {
  CUSTOM_MAX_PIXELS,
  IMAGE_PRESETS,
  IMAGE_PRESET_IDS,
  LEGACY_SIZES,
  MAX_ASPECT,
  MIN_PIXELS,
  resolveImageSize,
} from './image-sizes';
import { priceForImage } from '../credits/pricing';

/**
 * Output tokens the live API actually billed for each shape, at `low` quality.
 * Measured against gpt-image-2, not read off a doc page.
 *
 * This table is the whole reason the file has a test: provider cost tracks the
 * SHORT edge, not the pixel count, so `1248x1248` costs 44% more than the
 * larger-area `1024x1536`. Any preset added above the square's 196 would be
 * billed below cost, and this is what catches that.
 */
const MEASURED_OUTPUT_TOKENS: Record<string, number> = {
  '1536x512': 56,
  '1536x576': 70,
  '1456x768': 100,
  '1280x720': 106,
  '864x1536': 120,
  '1536x864': 120,
  '1024x1536': 158,
  '1536x1024': 158,
  '1088x1360': 181,
  '1024x1024': 196,
  '1248x1248': 228,
  '1536x1536': 279,
};

/** What a 1024x1024 costs. Every size we accept must sit at or under it, since
 *  that is the tier they are billed at. */
const SQUARE_TOKENS = MEASURED_OUTPUT_TOKENS['1024x1024'];

describe('image presets satisfy the provider constraints', () => {
  it.each(IMAGE_PRESET_IDS)('%s renders at a size the engine accepts', (id) => {
    const { size } = IMAGE_PRESETS[id];
    const [w, h] = size.split('x').map(Number);

    expect(w % 16, `${size} width must be divisible by 16`).toBe(0);
    expect(h % 16, `${size} height must be divisible by 16`).toBe(0);
    expect(w * h, `${size} must clear the minimum`).toBeGreaterThanOrEqual(MIN_PIXELS);
    expect(Math.max(w / h, h / w), `${size} must be within ${MAX_ASPECT}:1`).toBeLessThanOrEqual(MAX_ASPECT);
  });

  it.each(IMAGE_PRESET_IDS)('%s costs no more than the square it is billed as', (id) => {
    const { size } = IMAGE_PRESETS[id];
    const measured = MEASURED_OUTPUT_TOKENS[size];
    // A preset on an unmeasured size is the failure this catches: we would be
    // charging for it without knowing what it costs.
    expect(measured, `${size} has no measured cost — measure it before shipping it`).toBeDefined();
    expect(measured).toBeLessThanOrEqual(SQUARE_TOKENS);
  });
});

describe('pricing never falls below cost', () => {
  it('bills every preset at the square tier', () => {
    for (const id of IMAGE_PRESET_IDS) {
      const { size } = IMAGE_PRESETS[id];
      // The two legacy non-square sizes keep their original, cheaper tier.
      if (size === '1536x1024' || size === '1024x1536') continue;
      expect(priceForImage(size, 'high').action, `${id} (${size})`).toBe('image_high_1024');
    }
  });

  it('leaves the three original sizes priced exactly as before', () => {
    expect(priceForImage('1024x1024', 'high').credits).toBe(24);
    expect(priceForImage('1536x1024', 'high').credits).toBe(23);
    expect(priceForImage('1024x1536', 'high').credits).toBe(23);
  });

  it('never bills a preset below the cheaper non-square tier', () => {
    // Instagram's 4:5 is the shape that motivated this: 181 tokens against the
    // 158 the non-square tier is priced off. Billed as non-square it would lose
    // money on every call.
    expect(MEASURED_OUTPUT_TOKENS['1088x1360']).toBeGreaterThan(MEASURED_OUTPUT_TOKENS['1024x1536']);
    expect(priceForImage(IMAGE_PRESETS.ig_portrait.size, 'high').action).toBe('image_high_1024');
  });
});

describe('resolveImageSize', () => {
  it('resolves a preset to concrete pixels', () => {
    const r = resolveImageSize('ig_portrait');
    expect(r).toMatchObject({ ok: true, value: { size: '1088x1360', width: 1088, height: 1360 } });
  });

  it('accepts an explicit custom size within the bounds', () => {
    const r = resolveImageSize('1024x1024');
    expect(r.ok).toBe(true);
  });

  it.each(LEGACY_SIZES)('still accepts the original size %s', (size) => {
    expect(resolveImageSize(size).ok).toBe(true);
  });

  it('accepts 1024x1536 even though it exceeds the custom ceiling', () => {
    // Legacy sizes bypass CUSTOM_MAX_PIXELS on purpose — breaking a working
    // integration to tidy up our own rule would be the wrong trade.
    expect(1024 * 1536).toBeGreaterThan(CUSTOM_MAX_PIXELS);
    expect(resolveImageSize('1024x1536').ok).toBe(true);
  });

  it('rejects a size not divisible by 16 and names the nearest that is', () => {
    // Instagram publishes 1080x1350, which is why this was the reported bug.
    const r = resolveImageSize('1080x1350');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('1088x1360');
  });

  it('rejects a size below the minimum', () => {
    const r = resolveImageSize('800x800');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/minimum/);
  });

  it('rejects a custom size over the ceiling and points at the presets', () => {
    // 1248x1248 is the trap: smaller area than 1024x1536, but 44% dearer.
    const r = resolveImageSize('1248x1248');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/ceiling|presets/);
  });

  it('rejects anything wider than 3:1', () => {
    expect(resolveImageSize('1536x512').ok).toBe(true); // exactly 3:1 is fine
    const r = resolveImageSize('1584x512');
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown preset name', () => {
    const r = resolveImageSize('instagram_portrait');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('ig_portrait');
  });
});
