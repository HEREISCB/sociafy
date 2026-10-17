import { describe, it, expect } from 'vitest';
import { priceForVideo, creditsFromProviderUsd } from './pricing';

describe('priceForVideo — output pricing', () => {
  it('prices Quality at Seedance 2.5 rates through the shared markup', () => {
    // piapi.ai/docs/seedance-api/seedance-25: $0.15 / $0.35 / $0.80 per second.
    const rate = { '480p': 0.15, '720p': 0.35, '1080p': 0.8 } as const;
    for (const durationSec of [8, 15]) {
      for (const quality of ['480p', '720p', '1080p'] as const) {
        expect(priceForVideo({ durationSec, quality, fast: false }).credits)
          .toBe(creditsFromProviderUsd(rate[quality] * durationSec));
      }
    }
  });

  // Locked to the current numbers so the surcharge change can't drift them.
  it('prices the 8s buckets', () => {
    expect(priceForVideo({ durationSec: 8, quality: '480p', fast: true }).credits).toBe(75);
    expect(priceForVideo({ durationSec: 8, quality: '480p', fast: false }).credits).toBe(135);
    expect(priceForVideo({ durationSec: 8, quality: '720p', fast: true }).credits).toBe(145);
    expect(priceForVideo({ durationSec: 8, quality: '720p', fast: false }).credits).toBe(315);
    // Seedance has no 1080p Fast tier — falls back to Quality.
    expect(priceForVideo({ durationSec: 8, quality: '1080p', fast: true })).toEqual({
      action: 'video_8s_1080p_quality', credits: 720, surcharge: 0,
    });
  });

  it('prices the 15s buckets and scales off-bucket durations', () => {
    expect(priceForVideo({ durationSec: 15, quality: '720p', fast: false }).credits).toBe(591);
    expect(priceForVideo({ durationSec: 15, quality: '1080p', fast: false }).credits).toBe(1350);
    expect(priceForVideo({ durationSec: 6, quality: '720p', fast: false }).credits).toBe(236);
    expect(priceForVideo({ durationSec: 4, quality: '480p', fast: true }).credits).toBe(38);
    expect(priceForVideo({ durationSec: 13, quality: '480p', fast: false }).credits).toBe(220);
  });

  it('charges no surcharge without an input clip', () => {
    for (const inputDurationSec of [undefined, 0, -5]) {
      const p = priceForVideo({ durationSec: 8, quality: '720p', fast: false, inputDurationSec });
      expect(p).toEqual({ action: 'video_8s_720p_quality', credits: 315, surcharge: 0 });
    }
  });
});

describe('priceForVideo — reference-video surcharge', () => {
  it('adds (unit_price / 2) x input_duration in credits', () => {
    // 8s/720p/Quality = 315 cr for 8 provider-seconds ⇒ 39.375 cr/s; half-rate
    // on 10 input seconds = 196.875 ⇒ 197.
    const p = priceForVideo({ durationSec: 8, quality: '720p', fast: false, inputDurationSec: 10 });
    expect(p.surcharge).toBe(197);
    expect(p.credits).toBe(315 + 197);
    expect(p.action).toBe('video_8s_720p_quality'); // action key unchanged
  });

  it('scales the surcharge with resolution and the fast tier', () => {
    const s = (q: '480p' | '720p' | '1080p', fast: boolean) =>
      priceForVideo({ durationSec: 8, quality: q, fast, inputDurationSec: 10 }).surcharge;
    expect(s('480p', true)).toBe(47);    // 75/8 × 5
    expect(s('480p', false)).toBe(84);   // 135/8 × 5
    expect(s('720p', true)).toBe(91);    // 145/8 × 5
    expect(s('1080p', false)).toBe(450); // 720/8 × 5
    expect(s('720p', true)).toBeLessThan(s('720p', false));
  });

  it('uses the 15s bucket rate for 15s outputs', () => {
    // 591/15 = 39.4 cr/s ⇒ half-rate on 4s = 78.8 ⇒ 79.
    expect(priceForVideo({ durationSec: 15, quality: '720p', fast: false, inputDurationSec: 4 }).surcharge).toBe(79);
  });

  it('keeps the documented margin at the 60s hard cap', () => {
    // Provider surcharge at 720p Quality = ($0.35/2) × 60 = $10.50. At the
    // Business rate ($0.012/credit) the charge must cover it with roughly the
    // same ~35% markup the rest of the table uses.
    const { surcharge } = priceForVideo({ durationSec: 8, quality: '720p', fast: false, inputDurationSec: 60 });
    expect(surcharge).toBe(1181);
    const charged = surcharge * 0.012;
    expect(charged / 10.5).toBeGreaterThan(1.3);
    expect(charged / 10.5).toBeLessThan(1.4);
  });
});
