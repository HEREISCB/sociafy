import { env } from '../env';
import type { PlatformAdapter, PublishInput, PublishResult } from './types';
import { PlatformError } from './types';
import { stubProfile, stubPublish } from './stub';

const GRAPH = 'https://graph.facebook.com/v19.0';
const AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth';

// Facebook adapter only handles Facebook Pages now. Instagram is on its own
// flow via the Instagram Login product (instagramAdapter below), so we no
// longer pull instagram_basic / instagram_content_publish here — those were
// the pre-Jan-2025 legacy scopes anyway.
const FB_SCOPES = [
  'pages_show_list',         // discover which pages the user manages
  'pages_manage_posts',      // publish to /feed (the actual posting permission)
  'pages_read_engagement',   // read post insights for the dashboard
  'public_profile',          // user identity at OAuth time
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
    // Force the permissions dialog every time. Without this, Meta silently
    // reuses any previous "skipped" decision, so a user who unchecked
    // pages_manage_posts on first connect will never see it again.
    auth_type: 'rerequest',
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

/**
 * Verify the user actually granted the permissions we need. Meta's OAuth
 * dialog lets users decline individual scopes — without this check we'd
 * happily store a useless token and fail at publish time.
 */
async function fetchGrantedPermissions(userToken: string): Promise<Set<string>> {
  const resp = await fetch(`${GRAPH}/me/permissions?access_token=${userToken}`);
  if (!resp.ok) return new Set();
  const json = (await resp.json()) as { data?: Array<{ permission: string; status: 'granted' | 'declined' | 'expired' }> };
  return new Set((json.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission));
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

    // Fail loud at connect time if the user skipped a required permission in
    // the OAuth dialog. Without this we'd happily save a token that can't
    // actually post and only discover at publish time.
    const granted = await fetchGrantedPermissions(userToken);
    const required = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'] as const;
    const missing = required.filter((p) => !granted.has(p));
    if (missing.length > 0) {
      throw new PlatformError(
        'facebook_missing_permissions',
        403,
        `You skipped these Facebook permissions during sign-in: ${missing.join(', ')}. Reconnect Facebook and make sure every page-publishing toggle stays ON.`,
      );
    }

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

// ============================================================================
// Instagram API with Instagram Login (Meta, GA 2024)
//
// Lets Instagram Business / Creator accounts authenticate directly through an
// Instagram screen — no Facebook account, no Page selection, no Business
// Manager. Different OAuth host (instagram.com), different scopes (the
// `instagram_business_*` family), different publishing host
// (graph.instagram.com). Personal accounts cannot authenticate; this is a
// Meta limitation, not ours.
// ============================================================================

const IG_OAUTH_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const IG_OAUTH_TOKEN = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH = 'https://graph.instagram.com/v22.0';
const IG_GRAPH_NOVERSION = 'https://graph.instagram.com';

const IG_SCOPES = [
  'instagram_business_basic',            // required, includes "login with Instagram"
  'instagram_business_content_publish',  // posting
  'instagram_business_manage_comments',  // read/reply to comments (brand monitor, agent)
  'instagram_business_manage_insights',  // engagement metrics for the dashboard
  // Intentionally omitted: instagram_business_manage_messages + Human Agent —
  // we don't ship a DM workflow, and asking for them complicates app review.
];

function instagramConfigured() {
  return !!env.platforms.instagram.appId && !!env.platforms.instagram.appSecret;
}

export const instagramAdapter: PlatformAdapter = {
  id: 'instagram',
  label: 'Instagram',
  scopes: IG_SCOPES,
  isConfigured: instagramConfigured,
  // Refresh at 14 days remaining out of 60. Leaves a ~46-day average window
  // for the cron to retry if any single run fails. Meta lets you refresh
  // any time after 24h from creation, so the early refresh is cheap.
  refreshHorizonMs: 14 * 24 * 60 * 60 * 1000,
  buildAuthorizeUrl({ redirectUri, state }) {
    if (!instagramConfigured()) return `/oauth/instagram/callback?stub=1&state=${state}`;
    const params = new URLSearchParams({
      client_id: env.platforms.instagram.appId!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: IG_SCOPES.join(','),
      state,
    });
    return `${IG_OAUTH_AUTHORIZE}?${params.toString()}`;
  },
  async exchangeCode({ code, redirectUri }) {
    if (!instagramConfigured()) return stubProfile('instagram', 'unknown');

    // Step 1: short-lived token (~1 hour) from authorization code.
    const shortResp = await fetch(IG_OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.platforms.instagram.appId!,
        client_secret: env.platforms.instagram.appSecret!,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }),
    });
    if (!shortResp.ok) {
      throw new PlatformError('ig_short_token_failed', shortResp.status, await shortResp.text());
    }
    const short = (await shortResp.json()) as {
      access_token: string;
      user_id: number | string;
      permissions?: string;
    };

    // Step 2: swap short-lived for long-lived (60 days) immediately. Store
    // ONLY the long-lived token — the short-lived one is useless once we
    // have the longer one.
    const longUrl = new URL(`${IG_GRAPH_NOVERSION}/access_token`);
    longUrl.searchParams.set('grant_type', 'ig_exchange_token');
    longUrl.searchParams.set('client_secret', env.platforms.instagram.appSecret!);
    longUrl.searchParams.set('access_token', short.access_token);
    const longResp = await fetch(longUrl);
    if (!longResp.ok) {
      throw new PlatformError('ig_long_token_failed', longResp.status, await longResp.text());
    }
    const long = (await longResp.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };

    // Step 3: identify the connected account. /me returns user_id, username,
    // and account_type (BUSINESS or MEDIA_CREATOR). PERSONAL would have failed
    // at the OAuth step.
    const meResp = await fetch(
      `${IG_GRAPH}/me?fields=user_id,username,name,profile_picture_url,account_type&access_token=${long.access_token}`,
    );
    if (!meResp.ok) {
      throw new PlatformError('ig_me_failed', meResp.status, await meResp.text());
    }
    const me = (await meResp.json()) as {
      user_id?: string;
      id?: string;
      username: string;
      name?: string;
      profile_picture_url?: string;
      account_type?: string;
    };
    const igUserId = String(me.user_id ?? me.id ?? short.user_id);

    return {
      tokens: {
        accessToken: long.access_token,
        // IG Login uses the same token for refresh extension — store it in both
        // fields so ensureFreshToken() can swap it before expiry.
        refreshToken: long.access_token,
        expiresAt: new Date(Date.now() + long.expires_in * 1000),
        scope: IG_SCOPES.join(','),
        meta: {
          igUserId,
          accountType: me.account_type ?? 'BUSINESS',
        },
      },
      profile: {
        platformUserId: igUserId,
        handle: me.username,
        displayName: me.name ?? me.username,
        avatarUrl: me.profile_picture_url ?? null,
      },
    };
  },
  async refresh(refreshToken) {
    if (!instagramConfigured()) return { accessToken: 'stub', refreshToken };
    const url = new URL(`${IG_GRAPH_NOVERSION}/refresh_access_token`);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', refreshToken);
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new PlatformError('ig_refresh_failed', resp.status, await resp.text());
    }
    const t = (await resp.json()) as { access_token: string; expires_in?: number };
    return {
      accessToken: t.access_token,
      // Same token serves as future refresh source — extend in place.
      refreshToken: t.access_token,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
    };
  },
  async publishText(input: PublishInput): Promise<PublishResult> {
    if (!instagramConfigured() || input.account.accessToken === 'stub') return stubPublish(input, 'instagram');
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

    // Step 1: create the container.
    const containerBody = new URLSearchParams({
      [isVideo ? 'video_url' : 'image_url']: m.url,
      caption: input.text,
      access_token: token,
      ...(isVideo ? { media_type: 'REELS' } : {}),
    });
    const containerResp = await fetch(`${IG_GRAPH}/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: containerBody,
    });
    if (!containerResp.ok) {
      throw new PlatformError('instagram_container_failed', containerResp.status, await containerResp.text());
    }
    const container = (await containerResp.json()) as { id: string };

    // Step 2: publish. Short clips and images are usually FINISHED immediately;
    // longer reels may need polling — TODO when we hit a case in prod.
    const publishResp = await fetch(`${IG_GRAPH}/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ creation_id: container.id, access_token: token }),
    });
    if (!publishResp.ok) {
      throw new PlatformError('instagram_publish_failed', publishResp.status, await publishResp.text());
    }
    const data = (await publishResp.json()) as { id: string };
    return {
      platformPostId: data.id,
      url: null,
      raw: data,
    };
  },
};
