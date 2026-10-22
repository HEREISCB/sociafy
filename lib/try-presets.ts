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

/** Free media tries per browser per day. lib/try enforces it; it lives here so pages can state it. */
export const TRY_PER_DAY = { image: 2, video: 1 } as const;
/** How long a free try usually takes. */
export const TRY_WAIT = { image: '~30 s', video: '1–3 min' } as const;

/** Free-try pages. The return path after sign-up must be one of these. */
export const TRY_PAGES = [
  { path: '/try-image', kind: 'image', title: 'Free AI image generator', aspect: 'square', blurb: 'One sentence in, a square image out.' },
  { path: '/try-video', kind: 'video', title: 'Free AI video generator', aspect: '9:16', blurb: 'A 5-second vertical clip from a sentence.' },
  { path: '/free-instagram-post-generator', kind: 'image', title: 'Instagram post generator', aspect: 'portrait', blurb: 'A tall portrait image, sized for the feed.' },
  { path: '/free-youtube-thumbnail-maker', kind: 'image', title: 'YouTube thumbnail maker', aspect: 'landscape', blurb: 'Bold landscape images for thumbnails.' },
  { path: '/free-linkedin-image-generator', kind: 'image', title: 'LinkedIn image generator', aspect: 'landscape', blurb: 'Clean landscape visuals for posts.' },
  { path: '/free-reels-video-generator', kind: 'video', title: 'Reels, TikTok & Shorts video generator', aspect: '9:16', blurb: 'Vertical 9:16 clips for short-form.' },
  { path: '/free-youtube-video-generator', kind: 'video', title: 'YouTube video generator', aspect: '16:9', blurb: 'Widescreen 16:9 B-roll and intros.' },
] as const;

/** The output shape in plain words, and as a CSS aspect-ratio for the frame. */
export const SHAPE_LABEL: Record<TryAspect, string> = {
  square: 'Square 1024', portrait: 'Portrait 2:3', landscape: 'Landscape 3:2',
  '9:16': 'Vertical 9:16', '16:9': 'Widescreen 16:9', '1:1': 'Square 1:1',
};
export const aspectRatio = (kind: 'image' | 'video', a: TryAspect) => {
  const { w, h } = kind === 'image' ? IMAGE_ASPECTS[a as ImageAspect] : VIDEO_ASPECTS[a as VideoAspect];
  return `${w} / ${h}`;
};
