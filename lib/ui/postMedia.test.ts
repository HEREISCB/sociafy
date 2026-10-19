import { describe, expect, it } from 'vitest';
import { postMedia } from './postMedia';

const img = { mimeType: 'image/png' };
const img2 = { mimeType: 'image/jpeg' };
const vid = { mimeType: 'video/mp4' };

describe('postMedia', () => {
  it('Video mode posts only the clip; website images are references', () => {
    expect(postMedia('video', [img, img2, img])).toEqual([]);
    expect(postMedia('video', [img, vid, img2])).toEqual([vid]);
  });
  it('Image mode posts the images', () => {
    expect(postMedia('image', [img, vid, img2])).toEqual([img, img2]);
  });
  it('Text only posts no media', () => {
    expect(postMedia('text', [img, vid])).toEqual([]);
  });
});
