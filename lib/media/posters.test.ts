import { describe, it, expect, vi, beforeEach } from 'vitest';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
let rows: { assetId: string; posterKey: string }[] | Error = [];
const where = vi.fn(async () => { if (rows instanceof Error) throw rows; return rows; });
vi.mock('../db', () => ({ db: () => ({ select: () => ({ from: () => ({ where }) }) }) }));
vi.mock('../storage/r2', () => ({ publicUrlFor: (k: string) => `https://cdn/${k}` }));

import { posterUrls, savePoster, withPosters } from './posters';

beforeEach(() => { where.mockClear(); rows = []; });

describe('posters read path', () => {
  it('adds posterUrl to the media that have one, only for keys in the user prefix', async () => {
    rows = [{ assetId: A, posterKey: 'users/u1/p.jpg' }, { assetId: B, posterKey: 'users/other/p.jpg' }];
    const out = await withPosters('u1', [
      { id: 'd1', media: [{ id: A, url: 'v.mp4' }] },
      { id: 'd2', media: [{ id: B, url: 'w.mp4' }] },
      { id: 'd3', media: null },
    ]);
    expect(out[0].media).toEqual([{ id: A, url: 'v.mp4', posterUrl: 'https://cdn/users/u1/p.jpg' }]);
    expect(out[1].media).toEqual([{ id: B, url: 'w.mp4' }]);
    expect(out[2].media).toBeNull();
  });

  it('skips the query with no ids, and falls back to nothing when the table is missing', async () => {
    expect((await posterUrls('u1', [null, 'not-a-uuid'])).size).toBe(0);
    expect(where).not.toHaveBeenCalled();
    rows = new Error('relation "media_posters" does not exist');
    const media = [{ id: A, url: 'v.mp4' }];
    expect((await withPosters('u1', [{ media }]))[0].media).toBe(media);
  });

  it('refuses to save a key outside the owner prefix', async () => {
    expect(await savePoster('u1', A, 'users/other/p.jpg')).toBeNull();
    expect(await savePoster('u1', A, undefined)).toBeNull();
  });
});
