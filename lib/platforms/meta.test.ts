import { describe, it, expect, beforeEach, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('../env', () => ({
  env: {
    platforms: {
      meta: { appId: 'fbapp', appSecret: 'fbsecret', configId: null, webhookVerifyToken: null },
      instagram: { appId: 'igapp', appSecret: 'igsecret' },
    },
  },
}));

const { uploadBuffer } = vi.hoisted(() => ({
  uploadBuffer: vi.fn(async (a: { key: string; body: Buffer; contentType: string }) => ({ key: a.key, url: `https://cdn/${a.key}` })),
}));
vi.mock('../storage/r2', () => ({ uploadBuffer }));

import { facebookAdapter, instagramAdapter } from './meta';

type Call = { url: string; method: string; body: URLSearchParams | null };
let calls: Call[];
let route: (c: Call) => unknown;

function json(v: unknown) {
  return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  uploadBuffer.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body instanceof URLSearchParams ? init.body : null,
    };
    calls.push(c);
    const r = route(c);
    return r instanceof Response ? r : json(r);
  }));
});

describe('facebookAdapter.exchangeCode', () => {
  it('exchanges for a long-lived user token before fetching pages and stores the page list', async () => {
    route = (c) => {
      if (c.url.includes('fb_exchange_token')) return { access_token: 'LONG' };
      if (c.url.includes('/oauth/access_token')) return { access_token: 'SHORT', expires_in: 3600 };
      if (c.url.includes('/me/permissions')) {
        return { data: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'].map((permission) => ({ permission, status: 'granted' })) };
      }
      if (c.url.includes('/me/accounts')) {
        return { data: [{ id: 'p1', name: 'One', access_token: 'PT1' }, { id: 'p2', name: 'Two', access_token: 'PT2' }] };
      }
      if (c.url.includes('/me?')) return { id: 'u1' };
      throw new Error(`unexpected ${c.url}`);
    };
    const r = await facebookAdapter.exchangeCode({ code: 'c', redirectUri: 'https://x/cb' });
    const pagesCall = calls.find((c) => c.url.includes('/me/accounts'))!;
    expect(pagesCall.url).toContain('access_token=LONG');
    expect(pagesCall.url).toContain('graph.facebook.com/v25.0');
    expect(r.tokens.accessToken).toBe('PT1');
    expect(r.tokens.meta).toMatchObject({ userId: 'u1', pageId: 'p1', pages: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }] });
    expect(JSON.stringify(r.tokens.meta)).not.toContain('PT2');
  });

  it('falls back to the original token when the long-lived exchange fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    route = (c) => {
      if (c.url.includes('fb_exchange_token')) return new Response('nope', { status: 400 });
      if (c.url.includes('/oauth/access_token')) return { access_token: 'ORIG' };
      if (c.url.includes('/me/permissions')) {
        return { data: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'].map((permission) => ({ permission, status: 'granted' })) };
      }
      if (c.url.includes('/me/accounts')) return { data: [{ id: 'p1', name: 'One', access_token: 'PT1' }] };
      return { id: 'u1' };
    };
    await facebookAdapter.exchangeCode({ code: 'c', redirectUri: 'https://x/cb' });
    expect(calls.find((c) => c.url.includes('/me/accounts'))!.url).toContain('access_token=ORIG');
  });
});

describe('instagramAdapter', () => {
  const account = { id: 'acc1', accessToken: 'TOK', platformUserId: 'ig1' };

  it('stores the app-scoped id alongside igUserId', async () => {
    route = (c) => {
      if (c.url.includes('api.instagram.com')) return { data: [{ access_token: 'S', user_id: 'ig1' }] };
      if (c.url.includes('ig_exchange_token')) return { access_token: 'L', token_type: 'bearer', expires_in: 5184000 };
      return { id: 'scoped9', user_id: 'ig1', username: 'me' };
    };
    const r = await instagramAdapter.exchangeCode({ code: 'c', redirectUri: 'https://x/cb' });
    expect(r.tokens.meta).toMatchObject({ igUserId: 'ig1', igScopedId: 'scoped9' });
    expect(r.profile.platformUserId).toBe('ig1');
  });

  it('converts non-JPEG images to JPEG and publishes the converted URL', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    vi.spyOn(instagramAdapter, 'waitForPublish').mockResolvedValue({ ok: true, attempts: 1 });
    route = (c) => {
      if (c.url === 'https://src/a.png') return new Response(new Uint8Array(png));
      if (c.url.endsWith('/media')) return { id: 'cont1' };
      if (c.url.endsWith('/media_publish')) return { id: 'post1' };
      throw new Error(`unexpected ${c.url}`);
    };
    const r = await instagramAdapter.publishText({ text: 'hi', media: [{ url: 'https://src/a.png', mimeType: 'image/png' }], account });
    expect(r.platformPostId).toBe('post1');
    const up = uploadBuffer.mock.calls[0][0];
    expect(up.contentType).toBe('image/jpeg');
    expect((await sharp(up.body).metadata()).format).toBe('jpeg');
    const media = calls.find((c) => c.url.endsWith('/media'))!;
    expect(media.body!.get('image_url')).toBe(`https://cdn/${up.key}`);
    expect(media.body!.get('caption')).toBe('hi');
  });

  it('leaves JPEGs alone and builds a CAROUSEL for multiple media', async () => {
    vi.spyOn(instagramAdapter, 'waitForPublish').mockResolvedValue({ ok: true, attempts: 1 });
    let n = 0;
    route = (c) => {
      if (c.url.endsWith('/media')) return { id: `c${++n}` };
      if (c.url.endsWith('/media_publish')) return { id: 'post1' };
      throw new Error(`unexpected ${c.url}`);
    };
    await instagramAdapter.publishText({
      text: 'cap',
      media: [{ url: 'https://src/a.jpg', mimeType: 'image/jpeg' }, { url: 'https://src/b.mp4', mimeType: 'video/mp4' }],
      account,
    });
    expect(uploadBuffer).not.toHaveBeenCalled();
    const media = calls.filter((c) => c.url.endsWith('/media')).map((c) => Object.fromEntries(c.body!));
    expect(media[0]).toMatchObject({ image_url: 'https://src/a.jpg', is_carousel_item: 'true' });
    expect(media[0].caption).toBeUndefined();
    expect(media[1]).toMatchObject({ video_url: 'https://src/b.mp4', is_carousel_item: 'true', media_type: 'VIDEO' });
    expect(media[2]).toMatchObject({ media_type: 'CAROUSEL', children: 'c1,c2', caption: 'cap' });
    expect(calls.find((c) => c.url.endsWith('/media_publish'))!.body!.get('creation_id')).toBe('c3');
    expect(calls[0].url).toContain('graph.instagram.com/v25.0');
  });

  it('maps an undecodable image to instagram_image_unsupported (400)', async () => {
    route = (c) => {
      if (c.url === 'https://src/a.heic') return new Response('not an image');
      throw new Error(`unexpected ${c.url}`);
    };
    await expect(
      instagramAdapter.publishText({ text: 'x', media: [{ url: 'https://src/a.heic', mimeType: 'image/heic' }], account }),
    ).rejects.toMatchObject({ message: 'instagram_image_unsupported', status: 400 });
  });

  it('rejects more than 10 media items', async () => {
    const media = Array.from({ length: 11 }, (_, i) => ({ url: `https://src/${i}.jpg`, mimeType: 'image/jpeg' }));
    await expect(instagramAdapter.publishText({ text: 'x', media, account })).rejects.toMatchObject({ message: 'instagram_too_many_media' });
  });
});
