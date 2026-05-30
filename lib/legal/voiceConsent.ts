/**
 * Voice-cloning consent copy + validation.
 *
 * The exact text shown to the user at creation time is versioned here. When we
 * insert a `voices` row we store this version + the user's typed signature +
 * a timestamp, giving us a complete audit trail. Bump the version whenever the
 * agreement text changes so old acceptances remain attributable to old text.
 */

export const VOICE_CONSENT_VERSION = 'v1';

export const VOICE_CONSENT_TEXT = `Voice ownership & responsibility

By creating a Voice Twin you confirm that:

1. The audio you provide is a recording of YOUR OWN voice, and you have the
   full legal right to clone and use it.
2. You will not use this voice to impersonate any other person, to deceive,
   defraud, harass, or to create unlawful, harmful, or misleading content.
3. You are solely and fully responsible for everything you create with this
   voice on Sociafy.
4. Misuse may result in immediate account termination and may expose you to
   legal liability. Sociafy may retain a record of this consent.

This consent is recorded with your account, the date, and your typed signature.`;

export type ConsentInput = { version: string; signature: string };
export type ConsentResult = { ok: boolean; reason?: 'stale_version' | 'missing_signature' };

/** Server-side guard. Never trust the client: re-validate before creating a voice. */
export function validateConsent(input: ConsentInput): ConsentResult {
  if (input.version !== VOICE_CONSENT_VERSION) return { ok: false, reason: 'stale_version' };
  if (!input.signature || !input.signature.trim()) return { ok: false, reason: 'missing_signature' };
  return { ok: true };
}
