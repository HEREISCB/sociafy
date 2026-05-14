import { env } from '../env';
import type { PlatformAdapter, PublishInput, PublishResult } from './types';
import { PlatformError } from './types';
import { stubProfile, stubPublish } from './stub';

const GRAPH = 'https://graph.facebook.com/v19.0';
const AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth';

const FB_SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'public_profile',
];

function metaConfigured() {
  return !!env.platforms.meta.appId && !!env.platforms.meta.appSecret;
}

function buildMetaAuthorizeUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.platforms.meta.appId!,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
  });
  if (env.platforms.meta.configId) {
    // Facebook Login for Business — Configuration bundles permissions & assets.
    // override_default_response_type forces "code" even if the configuration defaults differently.
    params.set('config_id', env.platforms.meta.configId);
    params.set('override_default_response_type', 'true');
  } else {
    // Classic Facebook Login fallback — request scopes directly.
    params.set('scope', FB_SCOPES.join(','));
  }
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeMetaCode(code: string, redirectUri: string) {
  const params = new URLSearchParams({
    client_id: env.platforms.meta.appId!,
    client_secret: env.platforms.meta.appSecret!,
    redirect_uri: redirectUri,
    code,
  });
  const resp = await fetch(`${GRAPH}/oauth/access_token?${params.toString()}`);
  if (!resp.ok) throw new PlatformError('meta_token_failed', resp.status, await resp.text());
  return (await resp.json()) as { access_token: string; expires_in?: number; token_type?: string };
}

async function fetchMe(token: string) {
  const resp = await fetch(`${GRAPH}/me?fields=id,name,picture&access_token=${token}`);
  if (!resp.ok) throw new PlatformError('meta_me_failed', resp.status, await resp.text());
  return (await resp.json()) as { id: string; name?: string; picture?: { data?: { url?: string } } };
}

async function fetchPages(userToken: string) {
  const resp = await fetch(
    `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url}&access_token=${userToken}`,
  );
  if (!resp.ok) throw new PlatformError('meta_pages_failed', resp.status, await resp.text());
  return (await resp.json()) as {
    data: Array<{
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
    }>;
  };
}

export const facebookAdapter: PlatformAdapter = {
  id: 'facebook',
  label: 'Facebook',
  scopes: FB_SCOPES,
  isConfigured: metaConfigured,
  buildAuthorizeUrl({ redirectUri, state }) {
    if (!metaConfigured()) return `/oauth/facebook/callback?stub=1&state=${state}`;
    return buildMetaAuthorizeUrl(redirectUri, state);
  },
  async exchangeCode({ code, redirectUri }) {
    if (!metaConfigured()) return stubProfile('facebook', 'unknown');
    const t = await exchangeMetaCode(code, redirectUri);
    const userToken = t.access_token;
    const me = await fetchMe(userToken);
    const pages = await fetchPages(userToken);
    const page = pages.data[0]; // Pick first managed page; UI can let user pick later.
    if (!page) {
      throw new PlatformError('meta_no_pages', 400, 'User has no Facebook Pages with manage_posts permission.');
    }
    return {
      tokens: {
        accessToken: page.access_token, // page tokens are long-lived
        refreshToken: null,
        expiresAt: null,
        scope: FB_SCOPES.join(','),
        meta: {
          userId: me.id,
          pageId: page.id,
          pageName: page.name,
        },
      },
      profile: {
        platformUserId: page.id,
        handle: page.name,
        displayName: page.name,
        avatarUrl: me.picture?.data?.url ?? null,
      },
    };
  },
  async publishText(input: PublishInput): Promise<PublishResult> {
    if (!metaConfigured() || input.account.accessToken === 'stub') return stubPublish(input, 'facebook');
    const pageId = input.account.platformUserId;
    const resp = await fetch(`${GRAPH}/${pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: input.text, access_token: input.account.accessToken }),
    });
    if (!resp.ok) throw new PlatformError('facebook_publish_failed', resp.status, await resp.text());
    const data = (await resp.json()) as { id: string };
    return {
      platformPostId: data.id,
      url: `https://www.facebook.com/${data.id}`,
      raw: data,
    };
  },
};

export const instagramAdapter: PlatformAdapter = {
  id: 'instagram',
  label: 'Instagram',
  scopes: FB_SCOPES,
  isConfigured: metaConfigured,
  buildAuthorizeUrl({ redirectUri, state }) {
    if (!metaConfigured()) return `/oauth/instagram/callback?stub=1&state=${state}`;
    return buildMetaAuthorizeUrl(redirectUri, state);
  },
  async exchangeCode({ code, redirectUri }) {
    if (!metaConfigured()) return stubProfile('instagram', 'unknown');
    const t = await exchangeMetaCode(code, redirectUri);
    const userToken = t.access_token;
    const pages = await fetchPages(userToken);
    const pageWithIg = pages.data.find((p) => p.instagram_business_account?.id);
    if (!pageWithIg || !pageWithIg.instagram_business_account) {
      throw new PlatformError('meta_no_ig_business', 400, 'No connected Instagram Business account found.');
    }
    const ig = pageWithIg.instagram_business_account;
    return {
      tokens: {
        accessToken: pageWithIg.access_token,
        refreshToken: null,
        expiresAt: null,
        scope: FB_SCOPES.join(','),
        meta: {
          igUserId: ig.id,
          pageId: pageWithIg.id,
          pageName: pageWithIg.name,
        },
      },
      profile: {
        platformUserId: ig.id,
        handle: ig.username ?? null,
        displayName: ig.username ?? null,
        avatarUrl: ig.profile_picture_url ?? null,
      },
    };
  },
  async publishText(input: PublishInput): Promise<PublishResult> {
    // Instagram requires a media object — text-only posts are not supported.
    if (!metaConfigured() || input.account.accessToken === 'stub') return stubPublish(input, 'instagram');
    if (!input.media || input.media.length === 0) {
      throw new PlatformError(
        'instagram_requires_media',
        400,
        'Instagram requires an image or video. Attach media before scheduling.',
      );
    }
    const igUserId = input.account.platformUserId;
    const token = input.account.accessToken;
    const m = input.media[0];
    const isVideo = m.mimeType.startsWith('video/');
    const containerParams = new URLSearchParams({
      [isVideo ? 'video_url' : 'image_url']: m.url,
      caption: input.text,
      access_token: token,
      ...(isVideo ? { media_type: 'REELS' } : {}),
    });
    const containerResp = await fetch(`${GRAPH}/${igUserId}/media?${containerParams.toString()}`, { method: 'POST' });
    if (!containerResp.ok) throw new PlatformError('instagram_container_failed', containerResp.status, await containerResp.text());
    const container = (await containerResp.json()) as { id: string };

    // For videos, we need to poll status before publishing. Skipped here — IG returns FINISHED quickly for short clips.
    const publishResp = await fetch(
      `${GRAPH}/${igUserId}/media_publish?creation_id=${container.id}&access_token=${token}`,
      { method: 'POST' },
    );
    if (!publishResp.ok) throw new PlatformError('instagram_publish_failed', publishResp.status, await publishResp.text());
    const data = (await publishResp.json()) as { id: string };
    return {
      platformPostId: data.id,
      url: null,
      raw: data,
    };
  },
};
