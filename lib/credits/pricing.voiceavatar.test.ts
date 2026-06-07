import { describe, it, expect } from 'vitest';
import { creditsFor, priceForAvatar, CREDIT_PRICES, ACTION_LABELS } from './pricing';

describe('voice/avatar pricing', () => {
  it('has voice + tts action prices', () => {
    expect(creditsFor('voice_twin_create')).toBe(10);
    expect(creditsFor('tts_synthesis')).toBe(8);
  });

  it('prices avatar by quality', () => {
    expect(priceForAvatar('480p')).toEqual({ action: 'avatar_video_480p', credits: 50 });
    expect(priceForAvatar('720p')).toEqual({ action: 'avatar_video_720p', credits: 90 });
  });

  it('every action has a human label (ledger UI invariant)', () => {
    for (const key of Object.keys(CREDIT_PRICES) as (keyof typeof CREDIT_PRICES)[]) {
      expect(ACTION_LABELS[key], `missing label for ${key}`).toBeTruthy();
    }
  });
});
