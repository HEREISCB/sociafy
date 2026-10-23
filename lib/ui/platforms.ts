import type { Platform } from '../db/schema';
import { supportsKind, type PostKind } from '../platforms/capabilities';

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

/**
 * Display metadata for every connectable platform — the single source for the
 * Connect list on onboarding and Settings → Connections. `tip` is the one line
 * a user needs before leaving for the platform's sign-in screen.
 */
export type PlatformMeta = { id: Platform; short: string; name: string; tip: string };

export const PLATFORMS: PlatformMeta[] = [
  { id: 'instagram', short: 'ig', name: 'Instagram', tip: 'Switch to a Professional (Business or Creator) account in the Instagram app first.' },
  { id: 'facebook', short: 'fb', name: 'Facebook', tip: "You'll pick which Page to post to after signing in. Personal profiles aren't supported." },
  { id: 'linkedin', short: 'li', name: 'LinkedIn', tip: 'Posts go to your personal profile. Company Pages are not supported yet.' },
  { id: 'x', short: 'x', name: 'X', tip: 'If you manage several X accounts, sign in to the right one first.' },
  { id: 'tiktok', short: 'tt', name: 'TikTok', tip: 'TikTok takes video posts only.' },
  { id: 'youtube', short: 'yt', name: 'YouTube', tip: 'Sign in with the Google account that owns your channel. Video posts only.' },
  { id: 'reddit', short: 'rd', name: 'Reddit', tip: 'Text posts only. A dedicated brand account works best.' },
];

/**
 * A weekly content mix the connected platforms can actually take. Each draft
 * fans out to every platform that supports its kind, so text/image cover most
 * accounts and video is added only when some platform takes nothing else
 * (TikTok, YouTube). Video-only setups get video only.
 */
export function defaultMix(platforms: Platform[]): Record<PostKind, number> {
  const has = (k: PostKind) => platforms.some((p) => supportsKind(p, k));
  const videoOnly = platforms.some((p) => !supportsKind(p, 'text') && !supportsKind(p, 'image'));
  const text = has('text') ? 3 : 0;
  const image = has('image') ? (text ? 1 : 3) : 0;
  const video = videoOnly ? (text || image ? 1 : 3) : 0;
  return { text, image, video };
}

// OAuth start/callback report failures as ?oauth_error=<code>&platform=<p>.
// Shared by Connections and onboarding so a raw machine code never reaches the
// user. Unknown codes fall back to a generic line.
const IG_SIGNIN = "Instagram didn't accept the sign-in. Make sure the account is Professional (Business or Creator), then try again.";
const HANDSHAKE = (p: string) => `We couldn't complete the handshake with ${p}. Please try connecting again.`;
const OAUTH_ERROR_COPY: Record<string, (p: string) => string> = {
  access_denied: (p) => `You cancelled on ${p}'s screen. Connect again whenever you're ready.`,
  oauth_state: () => 'That connect link expired. Try again.',
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
  ig_long_token_failed: () => "Instagram signed you in but didn't finish issuing access. Wait a minute, then try again.",
  ig_account_not_allowed: () => "Instagram hasn't allowed Sociafy to use this account yet. Make sure it's a Professional account; if it still fails, contact support.",
  ig_me_failed: () => "We couldn't read your Instagram profile. Please try connecting again.",
  facebook_no_page_selected: () => 'No Facebook Page was shared with Sociafy. Reconnect and pick a Page on the "Select the business assets to share" screen.',
  facebook_missing_permissions: () => 'Some Facebook permissions were switched off. Reconnect and leave every page-publishing toggle on.',
  meta_token_failed: () => "Facebook didn't complete the sign-in. Please try connecting again.",
  meta_me_failed: () => "We couldn't read your Facebook profile. Please try connecting again.",
  meta_pages_failed: () => "We couldn't read your Facebook Pages. Please try connecting again.",
  youtube_no_channel: () => 'Your Google account has no YouTube channel. Create one at youtube.com, then reconnect.',
  youtube_token_failed: () => HANDSHAKE('YouTube'),
  youtube_channel_failed: () => "We couldn't read your YouTube channel. Please try connecting again.",
  linkedin_token_failed: () => HANDSHAKE('LinkedIn'),
  linkedin_me_failed: () => "We couldn't read your LinkedIn profile. Please try connecting again.",
  x_token_exchange_failed: () => HANDSHAKE('X'),
  x_me_failed: () => "We couldn't read your X profile. Please try connecting again.",
  x_missing_code_verifier: () => 'That connect link expired. Try again.',
  tiktok_token_failed: () => HANDSHAKE('TikTok'),
  reddit_token_exchange_failed: () => HANDSHAKE('Reddit'),
  reddit_me_failed: () => "We couldn't read your Reddit profile. Please try connecting again.",
  save_failed: (p) => `${p} signed you in, but we couldn't save the connection. Please try again.`,
};

export function oauthErrorCopy(code: string, platform: string): string {
  const label = PLATFORM_LABELS[platform] ?? platform;
  return OAUTH_ERROR_COPY[code]?.(label) ?? 'Something went wrong while connecting. Please try again.';
}

/** Retrying can't fix these, so don't offer a Retry button. */
export function oauthErrorRetryable(code: string): boolean {
  return code !== 'platform_not_configured' && code !== 'youtube_no_channel';
}
