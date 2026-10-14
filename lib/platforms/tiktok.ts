import { env } from '../env';
import type { AdapterAccount, PlatformAdapter, PublishInput, PublishResult, WaitForPublishResult } from './types';
import { PlatformError } from './types';
import { stubProfile, stubPublish } from './stub';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const ME_URL = 'https://open.tiktokapis.com/v2/user/info/';
const CREATOR_INFO_URL = 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/';
const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

/** TikTok answers 200 with `error: { code, message, log_id }`; only code 'ok' is success. */
type TikTokError = { code?: string; message?: string; log_id?: string };

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
    // user.info.basic only covers open_id/union_id/avatar_url/display_name;
    // username needs user.info.profile, which we don't request.
    const meResp = await fetch(`${ME_URL}?fields=open_id,union_id,avatar_url,display_name`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const me = meResp.ok
      ? ((await meResp.json()) as { data?: { user: { open_id: string; display_name?: string; avatar_url?: string } } })
      : null;
    const u = me?.data?.user;
    return {
      tokens,
      profile: {
        platformUserId: u?.open_id ?? t.open_id ?? 'unknown',
        handle: null,
        displayName: u?.display_name ?? null,
        avatarUrl: u?.avatar_url ?? null,
      },
    };
  },
  async refresh(refreshToken) {
    if (!this.isConfigured()) return { accessToken: 'stub', refreshToken };
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: env.platforms.tiktok.clientKey!,
        client_secret: env.platforms.tiktok.clientSecret!,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!resp.ok) throw new PlatformError('tiktok_refresh_failed', resp.status, await resp.text());
    const t = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? refreshToken,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
      scope: t.scope ?? null,
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
    // Unaudited clients may only post SELF_ONLY, and privacy_level must be
    // one of creator_info's privacy_level_options or init fails with
    // privacy_level_option_mismatch.
    const token = input.account.accessToken;
    const infoResp = await fetch(CREATOR_INFO_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    });
    const info = (await infoResp.json().catch(() => null)) as
      | { data?: { privacy_level_options?: string[] }; error?: TikTokError }
      | null;
    if (!infoResp.ok || info?.error?.code !== 'ok') {
      throw new PlatformError('tiktok_creator_info_failed', infoResp.ok ? 400 : infoResp.status, info?.error ?? info);
    }
    const privacyLevel = info.data?.privacy_level_options?.includes('PUBLIC_TO_EVERYONE')
      ? 'PUBLIC_TO_EVERYONE'
      : 'SELF_ONLY';

    // PULL_FROM_URL: TikTok downloads the video from our (verified) media domain.
    const m = input.media[0];
    const initResp = await fetch(INIT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        post_info: {
          title: input.text.slice(0, 150),
          privacy_level: privacyLevel,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: m.url,
        },
      }),
    });
    const data = (await initResp.json().catch(() => null)) as
      | { data?: { publish_id?: string }; error?: TikTokError }
      | null;
    if (!initResp.ok || data?.error?.code !== 'ok') {
      throw new PlatformError('tiktok_publish_init_failed', initResp.ok ? 400 : initResp.status, data?.error ?? data);
    }
    const publishId = data.data?.publish_id;
    if (!publishId) throw new PlatformError('tiktok_publish_init_failed', 502, 'init returned no publish_id');

    const done = await tiktokAdapter.waitForPublish!({ publishId, account: input.account });
    if (!done.ok && done.error !== 'timeout') {
      throw new PlatformError('tiktok_publish_failed', 502, `TikTok publish ${done.lastStatus ?? 'FAILED'}: ${done.error ?? ''}`);
    }
    // Timeout = TikTok accepted it and is still processing/moderating (can
    // take hours). The publish_id is real, so report success flagged pending.
    return {
      platformPostId: publishId,
      url: null,
      raw: { ...data, privacyLevel, status: done.ok ? done.lastStatus : 'pending' },
    };
  },
  /**
   * Poll /v2/post/publish/status/fetch/ until PUBLISH_COMPLETE or FAILED.
   * Rate limit is 30 req/min per token, so we poll every ~3-5s for up to 90s.
   */
  async waitForPublish({ publishId, account }: { publishId: string; account: AdapterAccount }): Promise<WaitForPublishResult> {
    const start = Date.now();
    let interval = 3_000;
    let attempts = 0;
    let lastStatus: string | undefined;
    while (Date.now() - start < 90_000) {
      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval + 500, 5_000);
      attempts++;
      try {
        const resp = await fetch(STATUS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ publish_id: publishId }),
        });
        if (!resp.ok) continue;
        const j = (await resp.json()) as { data?: { status?: string; fail_reason?: string }; error?: TikTokError };
        if (j.error?.code && j.error.code !== 'ok') continue;
        lastStatus = j.data?.status ?? lastStatus;
        if (lastStatus === 'PUBLISH_COMPLETE') return { ok: true, attempts, lastStatus };
        if (lastStatus === 'FAILED') return { ok: false, attempts, lastStatus, error: j.data?.fail_reason };
      } catch (e) {
        lastStatus = e instanceof Error ? e.message : String(e);
      }
    }
    return { ok: false, attempts, lastStatus, error: 'timeout' };
  },
};
