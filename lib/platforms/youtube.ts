import { env } from '../env';
import type { PlatformAdapter, PublishInput, PublishResult } from './types';
import { PlatformError } from './types';
import { stubProfile, stubPublish } from './stub';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'openid',
  'email',
  'profile',
];

export const youtubeAdapter: PlatformAdapter = {
  id: 'youtube',
  label: 'YouTube',
  scopes: SCOPES,
  isConfigured() {
    return !!env.platforms.google.clientId && !!env.platforms.google.clientSecret;
  },
  buildAuthorizeUrl({ redirectUri, state }) {
    if (!this.isConfigured()) return `/oauth/youtube/callback?stub=1&state=${state}`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.platforms.google.clientId!,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },
  async exchangeCode({ code, redirectUri }) {
    if (!this.isConfigured()) return stubProfile('youtube', 'unknown');
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.platforms.google.clientId!,
        client_secret: env.platforms.google.clientSecret!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResp.ok) throw new PlatformError('youtube_token_failed', tokenResp.status, await tokenResp.text());
    const t = (await tokenResp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    const tokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
      scope: t.scope ?? null,
    };
    const channelResp = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!channelResp.ok) throw new PlatformError('youtube_channel_failed', channelResp.status, await channelResp.text());
    const ch = (await channelResp.json()) as {
      items?: Array<{ id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } } }>;
    };
    const item = ch.items?.[0];
    return {
      tokens,
      profile: {
        platformUserId: item?.id ?? 'unknown',
        handle: item?.snippet.title ?? null,
        displayName: item?.snippet.title ?? null,
        avatarUrl: item?.snippet.thumbnails?.default?.url ?? null,
      },
    };
  },
  async refresh(refreshToken) {
    if (!this.isConfigured()) return { accessToken: 'stub', refreshToken };
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.platforms.google.clientId!,
        client_secret: env.platforms.google.clientSecret!,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!resp.ok) throw new PlatformError('youtube_refresh_failed', resp.status, await resp.text());
    const t = (await resp.json()) as {
      access_token: string;
      expires_in?: number;
      scope?: string;
    };
    // Google's refresh response does NOT return a new refresh_token — keep the original.
    return {
      accessToken: t.access_token,
      refreshToken,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
      scope: t.scope ?? null,
    };
  },
  async publishText(input: PublishInput): Promise<PublishResult> {
    if (!this.isConfigured() || input.account.accessToken === 'stub') return stubPublish(input, 'youtube');

    // YouTube has no public API for text-only posts or image posts —
    // Community Posts require YouTube Partner Program membership which
    // isn't accessible via OAuth. So we require a video attachment.
    const video = input.media?.find((m) => m.mimeType.startsWith('video/'));
    if (!video) {
      throw new PlatformError(
        'youtube_text_unsupported',
        400,
        'YouTube requires a video upload. Direct text or image-only posts are not supported by the YouTube API. Switch to Video mode and attach (or generate) a clip.',
      );
    }

    // 1. Fetch the video bytes from R2.
    const src = await fetch(video.url);
    if (!src.ok) {
      throw new PlatformError('youtube_source_fetch_failed', src.status, `Couldn't fetch ${video.url}`);
    }
    const videoBytes = Buffer.from(await src.arrayBuffer());

    // 2. Build a multipart/related body. YouTube Data API v3 supports
    //    multipart uploads up to ~256 MB. Generated Seedance clips are
    //    well under that — a 1080p / 15s mp4 is ~10-30 MB. For larger
    //    files we'd switch to resumable upload (uploadType=resumable).
    const boundary = `sociafy_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const text = input.text || 'Generated with Sociafy';
    // YouTube classifies a video as a Short based on vertical aspect +
    // ≤60s duration. The "#Shorts" tag in the description nudges the
    // classifier and shows up on the watch page.
    const metadata = {
      snippet: {
        title: text.slice(0, 95), // YouTube title cap is 100 chars; leave headroom
        description: `${text}\n\n#Shorts`,
        tags: ['Shorts'],
        categoryId: '22', // 22 = People & Blogs (broadest safe default)
      },
      status: {
        privacyStatus: 'public' as const,
        selfDeclaredMadeForKids: false,
      },
    };
    const parts: Buffer[] = [
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${video.mimeType}\r\n\r\n`),
      videoBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(parts);

    const resp = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.account.accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      },
    );

    if (!resp.ok) {
      const errBody = await resp.text();
      // Quota errors are the most common YouTube failure — surface them
      // clearly. Default Google Cloud project quota is 10,000 units/day,
      // and a video upload costs ~1,600 units → ~6 uploads/day before
      // hitting the wall. Quota increases must be requested from Google.
      if (resp.status === 403 && /quotaExceeded|youtube\.quota|dailyLimitExceeded/i.test(errBody)) {
        throw new PlatformError(
          'youtube_quota_exceeded',
          403,
          'YouTube Data API daily quota exhausted. Default is ~6 uploads/day per Google Cloud project. Request a quota increase at https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas, or try again tomorrow.',
        );
      }
      throw new PlatformError('youtube_publish_failed', resp.status, errBody);
    }

    const data = (await resp.json()) as { id: string; snippet?: { title?: string } };
    // Shorts URL form. YouTube auto-redirects between /shorts/ and /watch?v=
    // depending on the classifier's decision, so either URL works.
    const url = `https://www.youtube.com/shorts/${data.id}`;
    return {
      platformPostId: data.id,
      url,
      raw: data,
    };
  },
};
