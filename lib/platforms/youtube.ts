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
  async publishText(input: PublishInput): Promise<PublishResult> {
    // YouTube needs a video upload via resumable upload protocol — not implemented.
    if (!this.isConfigured() || input.account.accessToken === 'stub') return stubPublish(input, 'youtube');
    throw new PlatformError(
      'youtube_text_unsupported',
      400,
      'YouTube requires a video upload. Direct text posts are not supported.',
    );
  },
};
