/** Output shapes a free-try page can ask for. Client-safe: no server imports. */
export const IMAGE_ASPECTS = {
  square: { size: '1024x1024', w: 1024, h: 1024 },
  portrait: { size: '1024x1536', w: 1024, h: 1536 },
  landscape: { size: '1536x1024', w: 1536, h: 1024 },
} as const;
export const VIDEO_ASPECTS = {
  '9:16': { w: 360, h: 640 },
  '16:9': { w: 640, h: 360 },
  '1:1': { w: 480, h: 480 },
} as const;
export type ImageAspect = keyof typeof IMAGE_ASPECTS;
export type VideoAspect = keyof typeof VIDEO_ASPECTS;
export type TryAspect = ImageAspect | VideoAspect;

export const defaultAspect = (kind: 'image' | 'video'): TryAspect => (kind === 'image' ? 'square' : '9:16');
export const aspectFits = (kind: 'image' | 'video', a: string): a is TryAspect =>
  kind === 'image' ? a in IMAGE_ASPECTS : a in VIDEO_ASPECTS;

/** Free-try pages. The return path after sign-up must be one of these. */
export const TRY_PAGES = [
  { path: '/try-image', kind: 'image', title: 'Free AI image generator' },
  { path: '/try-video', kind: 'video', title: 'Free AI video generator' },
  { path: '/free-instagram-post-generator', kind: 'image', title: 'Instagram post generator' },
  { path: '/free-youtube-thumbnail-maker', kind: 'image', title: 'YouTube thumbnail maker' },
  { path: '/free-linkedin-image-generator', kind: 'image', title: 'LinkedIn image generator' },
  { path: '/free-reels-video-generator', kind: 'video', title: 'Reels, TikTok & Shorts video generator' },
  { path: '/free-youtube-video-generator', kind: 'video', title: 'YouTube video generator' },
] as const;
