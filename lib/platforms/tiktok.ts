import { env } from '../env';
import type { PlatformAdapter, PublishInput, PublishResult } from './types';
import { PlatformError } from './types';
import { stubProfile, stubPublish } from './stub';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const ME_URL = 'https://open.tiktokapis.com/v2/user/info/';

export const tiktokAdapter: PlatformAdapter = {
  id: 'tiktok',
  label: 'TikTok',
  scopes: ['user.info.basic', 'video.upload', 'video.publish'],
  isConfigured() {
    return !!env.platforms.tiktok.clientKey && !!env.platforms.tiktok.clientSecret;
  },
  buildAuthorizeUrl({ redirectUri, state }) {
    if (!this.isConfigured()) return `/oauth/tiktok/callback?stub=1&state=${state}`;
    const params = new URLSearchParams({
      client_key: env.platforms.tiktok.clientKey!,
      response_type: 'code',
      scope: this.scopes.join(','),
      redirect_uri: redirectUri,
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },
  async exchangeCode({ code, redirectUri }) {
    if (!this.isConfigured()) return stubProfile('tiktok', 'unknown');
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: env.platforms.tiktok.clientKey!,
        client_secret: env.platforms.tiktok.clientSecret!,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!resp.ok) throw new PlatformError('tiktok_token_failed', resp.status, await resp.text());
    const t = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      open_id?: string;
    };
    const tokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
      scope: t.scope ?? null,
    };
    const meResp = await fetch(`${ME_URL}?fields=open_id,union_id,avatar_url,display_name,username`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const me = meResp.ok
      ? ((await meResp.json()) as { data?: { user: { open_id: string; display_name?: string; username?: string; avatar_url?: string } } })
      : null;
    const u = me?.data?.user;
    return {
      tokens,
      profile: {
        platformUserId: u?.open_id ?? t.open_id ?? 'unknown',
        handle: u?.username ?? null,
        displayName: u?.display_name ?? null,
        avatarUrl: u?.avatar_url ?? null,
      },
    };
  },
  async publishText(input: PublishInput): Promise<PublishResult> {
    if (!this.isConfigured() || input.account.accessToken === 'stub') return stubPublish(input, 'tiktok');
    if (!input.media || input.media.length === 0) {
      throw new PlatformError(
        'tiktok_requires_video',
        400,
        'TikTok posts require a video. Attach a video before scheduling.',
      );
    }
    // Real TikTok video posting requires multi-step PULL_FROM_URL or chunked upload.
    // We initiate a PULL_FROM_URL post for a public video URL.
    const m = input.media[0];
    const initResp = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.account.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        post_info: {
          title: input.text.slice(0, 150),
          privacy_level: 'SELF_ONLY',
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: m.url,
        },
      }),
    });
    if (!initResp.ok) throw new PlatformError('tiktok_publish_init_failed', initResp.status, await initResp.text());
    const data = (await initResp.json()) as { data?: { publish_id?: string } };
    return {
      platformPostId: data.data?.publish_id ?? `tt-${Date.now()}`,
      url: null,
      raw: data,
    };
  },
};
