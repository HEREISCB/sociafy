import type { Platform } from '../db/schema';

// The UI uses short codes (x, li, ig, fb, tt, yt). The DB uses full names.
export const SHORT_TO_PLATFORM: Record<string, Platform> = {
  x: 'x',
  li: 'linkedin',
  linkedin: 'linkedin',
  ig: 'instagram',
  instagram: 'instagram',
  fb: 'facebook',
  facebook: 'facebook',
  tt: 'tiktok',
  tiktok: 'tiktok',
  yt: 'youtube',
  youtube: 'youtube',
  rd: 'reddit',
  reddit: 'reddit',
};

export const PLATFORM_TO_SHORT: Record<Platform, string> = {
  x: 'x',
  linkedin: 'li',
  instagram: 'ig',
  facebook: 'fb',
  tiktok: 'tt',
  youtube: 'yt',
  reddit: 'rd',
};

export function toPlatform(short: string): Platform | null {
  return SHORT_TO_PLATFORM[short] ?? null;
}

export const PLATFORM_LABELS: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  x: 'X',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  reddit: 'Reddit',
};

// OAuth start/callback report failures as ?oauth_error=<code>&platform=<p>.
// Shared by Connections and onboarding so a raw machine code never reaches the
// user. Unknown codes fall back to a generic line.
const IG_SIGNIN = "Instagram didn't accept the sign-in. Make sure the account is Professional (Business or Creator), then try again.";
const OAUTH_ERROR_COPY: Record<string, (p: string) => string> = {
  access_denied: (p) => `You cancelled on ${p}'s screen. Connect again whenever you're ready.`,
  oauth_state: () => 'That connect link expired — try again.',
  oauth_incomplete: (p) => `${p} didn't finish the sign-in. Please try connecting again.`,
  platform_not_configured: (p) => `${p} isn't available yet.`,
  rate_limited: () => 'Too many connection attempts. Wait a minute, then try again.',
  invalid_scope: () => 'The app is missing a required permission. Try connecting again, or contact support if it persists.',
  invalid_request: () => 'The connection request was malformed. Please try connecting again.',
  invalid_grant: () => 'The authorization expired before we could finish. Please try connecting again.',
  server_error: (p) => `${p} had a temporary error. Please try connecting again in a moment.`,
  temporarily_unavailable: (p) => `${p} is temporarily unavailable. Please try again shortly.`,
  state_mismatch: () => "The connection couldn't be verified (session expired). Please try connecting again.",
  token_exchange_failed: (p) => `We couldn't complete the handshake with ${p}. Please try connecting again.`,
  missing_code: (p) => `${p} didn't return an authorization code. Please try connecting again.`,
  ig_short_token_failed: () => IG_SIGNIN,
  ig_long_token_failed: () => IG_SIGNIN,
  ig_me_failed: () => "We couldn't read your Instagram profile. Please try connecting again.",
  facebook_no_page_selected: () => 'No Facebook Page was shared with Sociafy. Reconnect and pick a Page on the "Select the business assets to share" screen.',
  facebook_missing_permissions: () => 'Some Facebook permissions were switched off. Reconnect and leave every page-publishing toggle on.',
  meta_token_failed: () => "Facebook didn't complete the sign-in. Please try connecting again.",
  meta_me_failed: () => "We couldn't read your Facebook profile. Please try connecting again.",
  meta_pages_failed: () => "We couldn't read your Facebook Pages. Please try connecting again.",
};

export function oauthErrorCopy(code: string, platform: string): string {
  const label = PLATFORM_LABELS[platform] ?? platform;
  return OAUTH_ERROR_COPY[code]?.(label) ?? 'Something went wrong while connecting. Please try again.';
}

/** Retrying can't fix these, so don't offer a Retry button. */
export function oauthErrorRetryable(code: string): boolean {
  return code !== 'platform_not_configured';
}
