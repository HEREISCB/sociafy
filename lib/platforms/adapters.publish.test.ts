import { afterEach, describe, expect, it, vi } from 'vitest';

const tiktokEnv = vi.hoisted(() => ({ clientKey: 'k', clientSecret: 's', audited: false }));

vi.mock('../env', () => ({
  env: {
    platforms: {
      tiktok: tiktokEnv,
      google: { clientId: 'g', clientSecret: 's' },
      reddit: { clientId: 'r', clientSecret: 's' },
    },
  },
}));

import { tiktokAdapter } from './tiktok';
import { youtubeAdapter } from './youtube';
import { redditAdapter } from './reddit';
import { supportsKind } from './capabilities';

const account = { id: 'a1', accessToken: 'tok', platformUserId: 'u1' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Route fetch by URL substring; each route returns its responses in order (last one repeats). */
function routeFetch(routes: Record<string, unknown[]>) {
  const calls: { url: string; body?: string }[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: typeof init?.body === 'string' ? init.body : undefined });
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) throw new Error(`unexpected fetch ${u}`);
    const list = routes[key];
    const next = list.length > 1 ? list.shift() : list[0];
    return next instanceof Response ? next.clone() : json(next);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ok = { code: 'ok', message: '' };
const video = { url: 'https://cdn.example/v.mp4', mimeType: 'video/mp4' };

describe('capabilities', () => {
  it('X does not claim video support (x.ts throws x_video_unsupported)', () => {
    expect(supportsKind('x', 'video')).toBe(false);
    expect(supportsKind('x', 'image')).toBe(true);
  });
});

describe('tiktok publish', () => {
  it('uses SELF_ONLY even when PUBLIC_TO_EVERYONE is offered (unaudited app)', async () => {
    const calls = routeFetch({
      creator_info: [{ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, error: ok }],
      'video/init': [{ data: { publish_id: 'p_1' }, error: ok }],
    });
    const r = await tiktokAdapter.publishText({ text: 'hi', media: [video], account });
    expect(r.platformPostId).toBe('p_1');
    // Returns right after init — no status polling inside the request.
    expect(r.raw).toMatchObject({ privacyLevel: 'SELF_ONLY', status: 'pending' });
    expect(calls.some((c) => c.url.includes('status/fetch'))).toBe(false);
    expect(JSON.parse(calls.find((c) => c.url.includes('video/init'))!.body!).post_info.privacy_level).toBe('SELF_ONLY');
  });

  it('uses PUBLIC_TO_EVERYONE when TIKTOK_AUDITED and offered', async () => {
    tiktokEnv.audited = true;
    try {
      const calls = routeFetch({
        creator_info: [{ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, error: ok }],
        'video/init': [{ data: { publish_id: 'p_2' }, error: ok }],
      });
      const r = await tiktokAdapter.publishText({ text: 'hi', media: [video], account });
      expect(r.raw).toMatchObject({ privacyLevel: 'PUBLIC_TO_EVERYONE', status: 'pending' });
      expect(JSON.parse(calls.find((c) => c.url.includes('video/init'))!.body!).post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    } finally {
      tiktokEnv.audited = false;
    }
  });

  it('stays SELF_ONLY when audited but PUBLIC_TO_EVERYONE is not offered', async () => {
    tiktokEnv.audited = true;
    try {
      routeFetch({
        creator_info: [{ data: { privacy_level_options: ['SELF_ONLY'] }, error: ok }],
        'video/init': [{ data: { publish_id: 'p_3' }, error: ok }],
      });
      const r = await tiktokAdapter.publishText({ text: 'hi', media: [video], account });
      expect(r.raw).toMatchObject({ privacyLevel: 'SELF_ONLY' });
    } finally {
      tiktokEnv.audited = false;
    }
  });

  it('throws on a 200 init response carrying an error code', async () => {
    routeFetch({
      creator_info: [{ data: { privacy_level_options: ['SELF_ONLY'] }, error: ok }],
      'video/init': [{ data: {}, error: { code: 'spam_risk_too_many_posts', message: 'x' } }],
    });
    await expect(tiktokAdapter.publishText({ text: 'hi', media: [video], account })).rejects.toThrow(
      'tiktok_publish_init_failed',
    );
  });

  it("refuses a video longer than the creator's max before init", async () => {
    const calls = routeFetch({
      creator_info: [{ data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 60 }, error: ok }],
      'video/init': [{ data: { publish_id: 'p_4' }, error: ok }],
    });
    await expect(tiktokAdapter.publishText({ text: 'hi', media: [{ ...video, durationSec: 180 }], account })).rejects.toThrow('tiktok_video_too_long');
    expect(calls.some((c) => c.url.includes('video/init'))).toBe(false);
    const r = await tiktokAdapter.publishText({ text: 'hi', media: [{ ...video, durationSec: 60 }], account });
    expect(r.platformPostId).toBe('p_4');
  });

  it('throws when init returns no publish_id', async () => {
    routeFetch({
      creator_info: [{ data: { privacy_level_options: ['SELF_ONLY'] }, error: ok }],
      'video/init': [{ data: {}, error: ok }],
    });
    await expect(tiktokAdapter.publishText({ text: 'hi', media: [video], account })).rejects.toThrow(
      'tiktok_publish_init_failed',
    );
  });
});

describe('youtube', () => {
  it('flags forcedPrivate and uses the watch URL when Google locks the upload', async () => {
    routeFetch({
      'cdn.example': [new Response('bytes')],
      'upload/youtube': [{ id: 'vid1', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } }],
    });
    const r = await youtubeAdapter.publishText({ text: 'hi', media: [video], account });
    expect(r.url).toBe('https://www.youtube.com/watch?v=vid1');
    expect(r.raw).toMatchObject({ forcedPrivate: true });
  });

  it('keeps the Shorts URL when the video is public', async () => {
    routeFetch({
      'cdn.example': [new Response('bytes')],
      'upload/youtube': [{ id: 'vid2', status: { privacyStatus: 'public', uploadStatus: 'uploaded' } }],
    });
    const r = await youtubeAdapter.publishText({ text: 'hi', media: [video], account });
    expect(r.url).toBe('https://www.youtube.com/shorts/vid2');
    expect(r.raw).not.toHaveProperty('forcedPrivate');
  });

  it('rejects connecting an account without a channel', async () => {
    routeFetch({
      'oauth2.googleapis.com/token': [{ access_token: 'at', expires_in: 3600 }],
      'youtube/v3/channels': [{ items: [] }],
    });
    await expect(youtubeAdapter.exchangeCode({ code: 'c', redirectUri: 'https://x/cb' })).rejects.toThrow(
      'youtube_no_channel',
    );
  });

  it('uses customUrl as the handle', async () => {
    routeFetch({
      'oauth2.googleapis.com/token': [{ access_token: 'at', expires_in: 3600 }],
      'youtube/v3/channels': [{ items: [{ id: 'UC1', snippet: { title: 'Chan', customUrl: '@chan' } }] }],
    });
    const { profile } = await youtubeAdapter.exchangeCode({ code: 'c', redirectUri: 'https://x/cb' });
    expect(profile).toMatchObject({ platformUserId: 'UC1', handle: 'chan', displayName: 'Chan' });
  });
});

describe('reddit', () => {
  it('throws on a 200 response with json.errors', async () => {
    routeFetch({
      'api/submit': [{ json: { errors: [['RATELIMIT', 'you are doing that too much', 'ratelimit']] } }],
    });
    const p = redditAdapter.publishText({ text: 'hi', account: { ...account, meta: { subreddit: 'test' } } });
    await expect(p).rejects.toMatchObject({ message: 'reddit_submit_failed', status: 429 });
  });

  it('builds the comment URL from its permalink, not the t1_ fullname', async () => {
    routeFetch({
      'api/comment': [
        { json: { errors: [], data: { things: [{ data: { name: 't1_abc', permalink: '/r/x/comments/p1/t/abc/' } }] } } },
      ],
    });
    const r = await redditAdapter.publishText({ text: 'hi', account: { ...account, meta: { parentId: 't3_p1' } } });
    expect(r.platformPostId).toBe('t1_abc');
    expect(r.url).toBe('https://www.reddit.com/r/x/comments/p1/t/abc/');
  });
});
