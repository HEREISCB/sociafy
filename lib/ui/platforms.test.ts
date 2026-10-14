import { describe, expect, it } from 'vitest';
import { PLATFORMS, defaultMix, oauthErrorCopy, oauthErrorRetryable } from './platforms';

describe('oauthErrorCopy', () => {
  it('names the platform and never echoes a raw code', () => {
    expect(oauthErrorCopy('access_denied', 'linkedin')).toContain("LinkedIn's screen");
    expect(oauthErrorCopy('platform_not_configured', 'tiktok')).toBe("TikTok isn't available yet.");
    expect(oauthErrorCopy('some_new_code', 'x')).not.toContain('some_new_code');
  });

  it('does not offer a retry for an unconfigured platform', () => {
    expect(oauthErrorRetryable('platform_not_configured')).toBe(false);
    expect(oauthErrorRetryable('access_denied')).toBe(true);
    expect(oauthErrorRetryable('youtube_no_channel')).toBe(false);
    expect(oauthErrorRetryable('save_failed')).toBe(true);
  });

  it('has human copy for every exchangeCode-time code', () => {
    const generic = oauthErrorCopy('some_new_code', 'x');
    for (const code of [
      'youtube_no_channel', 'youtube_token_failed', 'youtube_channel_failed',
      'linkedin_token_failed', 'linkedin_me_failed',
      'x_token_exchange_failed', 'x_me_failed', 'x_missing_code_verifier',
      'tiktok_token_failed', 'reddit_token_exchange_failed', 'reddit_me_failed',
      'meta_token_failed', 'meta_me_failed', 'meta_pages_failed',
      'ig_short_token_failed', 'ig_long_token_failed', 'ig_me_failed', 'save_failed',
    ]) {
      expect(oauthErrorCopy(code, 'youtube'), code).not.toBe(generic);
    }
    expect(oauthErrorCopy('youtube_no_channel', 'youtube')).toContain('youtube.com');
  });
});

describe('defaultMix', () => {
  it('fits what the connected platforms accept', () => {
    expect(defaultMix(['x', 'linkedin'])).toEqual({ text: 3, image: 1, video: 0 });
    expect(defaultMix(['instagram'])).toEqual({ text: 0, image: 3, video: 0 });
    expect(defaultMix(['youtube', 'tiktok'])).toEqual({ text: 0, image: 0, video: 3 });
    expect(defaultMix(['linkedin', 'youtube'])).toEqual({ text: 3, image: 1, video: 1 });
    expect(defaultMix([])).toEqual({ text: 0, image: 0, video: 0 });
  });
});

describe('PLATFORMS', () => {
  it('lists every platform once, with a tip', () => {
    expect(new Set(PLATFORMS.map((p) => p.id)).size).toBe(7);
    for (const p of PLATFORMS) expect(p.tip.length).toBeGreaterThan(0);
  });
});
