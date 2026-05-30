import { describe, it, expect } from 'vitest';
import { validateConsent, VOICE_CONSENT_VERSION } from '../../../lib/legal/voiceConsent';

// The voice-create route's security hinges on the consent guard it imports.
// Routes themselves need Clerk + DB to exercise end-to-end; the guard is the
// unit worth pinning here so a regression can't silently open creation.
describe('voice create consent guard', () => {
  it('blocks creation without a signature', () => {
    expect(validateConsent({ version: VOICE_CONSENT_VERSION, signature: '' }).ok).toBe(false);
  });

  it('allows creation with a current-version signature', () => {
    expect(validateConsent({ version: VOICE_CONSENT_VERSION, signature: 'Jane Doe' }).ok).toBe(true);
  });
});
