import { env } from '../env';
import type { PlatformAdapter, PublishInput, PublishResult } from './types';
import { PlatformError } from './types';
import { stubProfile, stubPublish } from './stub';

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const ME_URL = 'https://api.linkedin.com/v2/userinfo';
const POST_URL = 'https://api.linkedin.com/v2/ugcPosts';

export const linkedinAdapter: PlatformAdapter = {
  id: 'linkedin',
  label: 'LinkedIn',
  scopes: ['openid', 'profile', 'w_member_social'],
  isConfigured() {
    return !!env.platforms.linkedin.clientId && !!env.platforms.linkedin.clientSecret;
  },
  buildAuthorizeUrl({ redirectUri, state }) {
    if (!this.isConfigured()) return `/oauth/linkedin/callback?stub=1&state=${state}`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.platforms.linkedin.clientId!,
      redirect_uri: redirectUri,
      scope: this.scopes.join(' '),
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },
  async exchangeCode({ code, redirectUri }) {
    if (!this.isConfigured()) return stubProfile('linkedin', 'unknown');
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: env.platforms.linkedin.clientId!,
        client_secret: env.platforms.linkedin.clientSecret!,
      }),
    });
    if (!tokenResp.ok) throw new PlatformError('linkedin_token_failed', tokenResp.status, await tokenResp.text());
    const t = (await tokenResp.json()) as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
    const tokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
      scope: t.scope ?? null,
    };
    const meResp = await fetch(ME_URL, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    if (!meResp.ok) throw new PlatformError('linkedin_me_failed', meResp.status, await meResp.text());
    const me = (await meResp.json()) as { sub: string; name?: string; given_name?: string; picture?: string; email?: string };
    return {
      tokens,
      profile: {
        platformUserId: me.sub,
        handle: me.email ?? me.sub,
        displayName: me.name ?? me.given_name ?? null,
        avatarUrl: me.picture ?? null,
      },
    };
  },
  async publishText(input: PublishInput): Promise<PublishResult> {
    if (!this.isConfigured() || input.account.accessToken === 'stub') return stubPublish(input, 'linkedin');
    const author = `urn:li:person:${input.account.platformUserId}`;
    const body = {
      author,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: input.text },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    };
    const resp = await fetch(POST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.account.accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new PlatformError('linkedin_publish_failed', resp.status, await resp.text());
    const data = (await resp.json()) as { id: string };
    return {
      platformPostId: data.id,
      url: `https://www.linkedin.com/feed/update/${encodeURIComponent(data.id)}/`,
      raw: data,
    };
  },
};
