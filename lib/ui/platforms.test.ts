import { describe, expect, it } from 'vitest';
import { oauthErrorCopy, oauthErrorRetryable } from './platforms';

describe('oauthErrorCopy', () => {
  it('names the platform and never echoes a raw code', () => {
    expect(oauthErrorCopy('access_denied', 'linkedin')).toContain("LinkedIn's screen");
    expect(oauthErrorCopy('platform_not_configured', 'tiktok')).toBe("TikTok isn't available yet.");
    expect(oauthErrorCopy('some_new_code', 'x')).not.toContain('some_new_code');
  });

  it('does not offer a retry for an unconfigured platform', () => {
    expect(oauthErrorRetryable('platform_not_configured')).toBe(false);
    expect(oauthErrorRetryable('access_denied')).toBe(true);
  });
});
