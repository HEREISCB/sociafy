import type { Platform } from '../db/schema';

export type PostKind = 'text' | 'image' | 'video';

/**
 * What each platform's publish API actually accepts as a primary post.
 *
 * Instagram requires media, TikTok and YouTube require a video (YouTube
 * Community posts have no public endpoint), Reddit's adapter rejects any
 * attachment. Scheduling a post a platform can't take is a guaranteed
 * `*_publish_failed` hours later, so this is enforced at POST /api/schedule
 * and mirrored in the composer's platform pills.
 *
 * Keep in sync with PLATFORM_LIST in components/compose.tsx.
 */
export const PLATFORM_SUPPORTS: Record<Platform, Record<PostKind, boolean>> = {
  x: { text: true, image: true, video: true },
  linkedin: { text: true, image: true, video: true },
  facebook: { text: true, image: true, video: true },
  instagram: { text: false, image: true, video: true },
  tiktok: { text: false, image: false, video: true },
  youtube: { text: false, image: false, video: true },
  reddit: { text: true, image: false, video: false },
};

const UNSUPPORTED_HINT: Partial<Record<Platform, Partial<Record<PostKind, string>>>> = {
  instagram: { text: 'Instagram needs an image or video — text-only posts are rejected.' },
  tiktok: {
    text: 'TikTok needs a video.',
    image: 'TikTok needs a video clip, not a single image.',
  },
  youtube: {
    text: 'YouTube only accepts video uploads via API — Community posts have no public endpoint.',
    image: 'YouTube only accepts video uploads — image posts go to Community, which has no API.',
  },
  reddit: {
    image: 'Reddit posting supports text only right now.',
    video: 'Reddit posting supports text only right now.',
  },
};

/** Classify a post by what's attached: a video wins, then an image, else text. */
export function postKind(media: readonly { mimeType?: string | null }[] | null | undefined): PostKind {
  if (!media || media.length === 0) return 'text';
  if (media.some((m) => m.mimeType?.startsWith('video/'))) return 'video';
  return 'image';
}

export function supportsKind(platform: Platform, kind: PostKind): boolean {
  return PLATFORM_SUPPORTS[platform]?.[kind] ?? true;
}

/** Why `platform` can't take a `kind` post. Empty string when it can. */
export function unsupportedReason(platform: Platform, kind: PostKind): string {
  if (supportsKind(platform, kind)) return '';
  return UNSUPPORTED_HINT[platform]?.[kind] ?? `${platform} does not accept ${kind}-only posts.`;
}
