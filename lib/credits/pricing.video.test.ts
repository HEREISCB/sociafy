import { describe, it, expect } from 'vitest';
import { priceForVideo } from './pricing';

describe('priceForVideo — output pricing is unchanged', () => {
  // Locked to the current numbers so the surcharge change can't drift them.
  it('prices the 8s buckets', () => {
    expect(priceForVideo({ durationSec: 8, quality: '480p', fast: true }).credits).toBe(75);
    expect(priceForVideo({ durationSec: 8, quality: '480p', fast: false }).credits).toBe(90);
    expect(priceForVideo({ durationSec: 8, quality: '720p', fast: true }).credits).toBe(145);
    expect(priceForVideo({ durationSec: 8, quality: '720p', fast: false }).credits).toBe(180);
    // Seedance has no 1080p Fast tier — falls back to Quality.
    expect(priceForVideo({ durationSec: 8, quality: '1080p', fast: true })).toEqual({
      action: 'video_8s_1080p_quality', credits: 445, surcharge: 0,
    });
  });

  it('prices the 15s buckets and scales off-bucket durations', () => {
    expect(priceForVideo({ durationSec: 15, quality: '720p', fast: false }).credits).toBe(335);
    expect(priceForVideo({ durationSec: 15, quality: '1080p', fast: false }).credits).toBe(835);
    expect(priceForVideo({ durationSec: 6, quality: '720p', fast: false }).credits).toBe(135);
    expect(priceForVideo({ durationSec: 4, quality: '480p', fast: true }).credits).toBe(38);
    expect(priceForVideo({ durationSec: 13, quality: '480p', fast: false }).credits).toBe(146);
  });

  it('charges no surcharge without an input clip', () => {
    for (const inputDurationSec of [undefined, 0, -5]) {
      const p = priceForVideo({ durationSec: 8, quality: '720p', fast: false, inputDurationSec });
      expect(p).toEqual({ action: 'video_8s_720p_quality', credits: 180, surcharge: 0 });
    }
  });
});

describe('priceForVideo — reference-video surcharge', () => {
  it('adds (unit_price / 2) x input_duration in credits', () => {
    // 8s/720p/Quality = 180 cr for 8 provider-seconds ⇒ 22.5 cr/s; half-rate on
    // 10 input seconds = 112.5 ⇒ 113.
    const p = priceForVideo({ durationSec: 8, quality: '720p', fast: false, inputDurationSec: 10 });
    expect(p.surcharge).toBe(113);
    expect(p.credits).toBe(180 + 113);
    expect(p.action).toBe('video_8s_720p_quality'); // action key unchanged
  });

  it('scales the surcharge with resolution and the fast tier', () => {
    const s = (q: '480p' | '720p' | '1080p', fast: boolean) =>
      priceForVideo({ durationSec: 8, quality: q, fast, inputDurationSec: 10 }).surcharge;
    expect(s('480p', true)).toBe(47);    // 75/8 × 5
    expect(s('480p', false)).toBe(56);   // 90/8 × 5
    expect(s('720p', true)).toBe(91);    // 145/8 × 5
    expect(s('1080p', false)).toBe(278); // 445/8 × 5
    expect(s('720p', true)).toBeLessThan(s('720p', false));
  });

  it('uses the 15s bucket rate for 15s outputs', () => {
    // 335/15 = 22.33 cr/s ⇒ half-rate on 4s = 44.67 ⇒ 45.
    expect(priceForVideo({ durationSec: 15, quality: '720p', fast: false, inputDurationSec: 4 }).surcharge).toBe(45);
  });

  it('keeps the documented margin at the 60s hard cap', () => {
    // Provider surcharge at 720p Quality = ($0.20/2) × 60 = $6.00. At the
    // Business rate ($0.012/credit) the charge must cover it with roughly the
    // same ~35% markup the rest of the table uses.
    const { surcharge } = priceForVideo({ durationSec: 8, quality: '720p', fast: false, inputDurationSec: 60 });
    expect(surcharge).toBe(675);
    const charged = surcharge * 0.012;
    expect(charged / 6).toBeGreaterThan(1.3);
    expect(charged / 6).toBeLessThan(1.4);
  });
});
