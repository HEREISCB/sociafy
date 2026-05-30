import { describe, it, expect } from 'vitest';
import { VOICE_CONSENT_VERSION, VOICE_CONSENT_TEXT, validateConsent } from './voiceConsent';

describe('voice consent', () => {
  it('exposes a current version + non-empty text', () => {
    expect(VOICE_CONSENT_VERSION).toMatch(/^v\d+$/);
    expect(VOICE_CONSENT_TEXT.length).toBeGreaterThan(100);
  });

  it('accepts a current-version signature', () => {
    expect(validateConsent({ version: VOICE_CONSENT_VERSION, signature: 'Jane Doe' }).ok).toBe(true);
  });

  it('rejects empty / whitespace signature', () => {
    expect(validateConsent({ version: VOICE_CONSENT_VERSION, signature: '   ' })).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('rejects a stale consent version', () => {
    expect(validateConsent({ version: 'v0', signature: 'Jane Doe' })).toEqual({
      ok: false,
      reason: 'stale_version',
    });
  });
});
