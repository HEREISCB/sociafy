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
};

export const PLATFORM_TO_SHORT: Record<Platform, string> = {
  x: 'x',
  linkedin: 'li',
  instagram: 'ig',
  facebook: 'fb',
  tiktok: 'tt',
  youtube: 'yt',
};

export function toPlatform(short: string): Platform | null {
  return SHORT_TO_PLATFORM[short] ?? null;
}
