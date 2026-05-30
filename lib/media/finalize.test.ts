import { describe, it, expect, vi } from 'vitest';

vi.mock('../storage/r2', () => ({
  makeMediaKey: (u: string, n: string) => `media/${u}/${n}`,
  publicUrlFor: (k: string) => `https://cdn.test/${k}`,
  uploadBuffer: vi.fn(async () => {}),
}));

import { downloadToBuffer, storeFromUrl } from './finalize';

describe('finalize helpers', () => {
  it('exports the download + store helpers', () => {
    expect(typeof downloadToBuffer).toBe('function');
    expect(typeof storeFromUrl).toBe('function');
  });

  it('rejects an invalid URL in downloadToBuffer', async () => {
    await expect(downloadToBuffer('not a url')).rejects.toBeDefined();
  });
});
