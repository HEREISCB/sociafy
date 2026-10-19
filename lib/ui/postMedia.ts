export type MediaMode = 'text' | 'image' | 'video';

/**
 * What a post publishes (and the preview shows) in each media mode. Video
 * posts only clips — other attachments are references for the video; Image
 * posts only images; Text only posts no media.
 */
export function postMedia<T extends { mimeType?: string }>(mode: MediaMode, items: readonly T[]): T[] {
  if (mode === 'text') return [];
  const prefix = mode === 'video' ? 'video/' : 'image/';
  return items.filter((m) => m.mimeType?.startsWith(prefix));
}
