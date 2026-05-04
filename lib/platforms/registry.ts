import type { Platform } from '../db/schema';
import type { PlatformAdapter } from './types';
import { xAdapter } from './x';
import { linkedinAdapter } from './linkedin';
import { facebookAdapter, instagramAdapter } from './meta';
import { tiktokAdapter } from './tiktok';
import { youtubeAdapter } from './youtube';

export const ADAPTERS: Record<Platform, PlatformAdapter> = {
  x: xAdapter,
  linkedin: linkedinAdapter,
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  tiktok: tiktokAdapter,
  youtube: youtubeAdapter,
};

export function getAdapter(p: Platform): PlatformAdapter {
  return ADAPTERS[p];
}

export function platformLabel(p: Platform): string {
  return ADAPTERS[p].label;
}
