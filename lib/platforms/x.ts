import crypto from 'crypto';
import { env } from '../env';
import type { PlatformAdapter, PublishInput, PublishResult } from './types';
import { PlatformError } from './types';
import { stubProfile, stubPublish } from './stub';

const AUTH_URL = 'https://twitter.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const ME_URL = 'https://api.twitter.com/2/users/me?user.fields=username,profile_image_url,name';
const TWEET_URL = 'https://api.twitter.com/2/tweets';

export const xAdapter: PlatformAdapter = {
  id: 'x',
  label: 'X',
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  isConfigured() {
    return !!env.platforms.x.clientId && !!env.platforms.x.clientSecret;
  },
  buildAuthorizeUrl({ redirectUri, state, codeVerifier }) {
    if (!this.isConfigured()) return `/oauth/x/callback?stub=1&state=${state}`;
    const challenge = codeVerifier ? toS256(codeVerifier) : 'challenge';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.platforms.x.clientId!,
      redirect_uri: redirectUri,
      scope: this.scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${params.toString()}`;
  },
  async exchangeCode({ code, redirectUri, codeVerifier }) {
    if (!this.isConfigured()) {
      return stubProfile('x', 'unknown');
    }
    const basic = Buffer.from(`${env.platforms.x.clientId}:${env.platforms.x.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier ?? '',
    });
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!tokenResp.ok) {
      throw new PlatformError(`x_token_exchange_failed`, tokenResp.status, await tokenResp.text());
    }
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
    const meResp = await fetch(ME_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!meResp.ok) {
      throw new PlatformError(`x_me_failed`, meResp.status, await meResp.text());
    }
    const me = (await meResp.json()) as {
      data: { id: string; username: string; name?: string; profile_image_url?: string };
    };
    return {
      tokens,
      profile: {
        platformUserId: me.data.id,
        handle: me.data.username,
        displayName: me.data.name ?? me.data.username,
        avatarUrl: me.data.profile_image_url ?? null,
      },
    };
  },
  async refresh(refreshToken) {
    if (!this.isConfigured()) {
      return { accessToken: 'stub', refreshToken };
    }
    const basic = Buffer.from(`${env.platforms.x.clientId}:${env.platforms.x.clientSecret}`).toString('base64');
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!resp.ok) throw new PlatformError('x_refresh_failed', resp.status, await resp.text());
    const t = (await resp.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? refreshToken,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
    };
  },
  async publishText(input: PublishInput): Promise<PublishResult> {
    if (!this.isConfigured() || input.account.accessToken === 'stub') return stubPublish(input, 'x');
    // When the shield approves a reply to a specific tweet, the approve route
    // passes the parent tweet id via account.meta.parentId. Thread the reply
    // by setting reply.in_reply_to_tweet_id; otherwise post a standalone tweet.
    const meta = input.account.meta as { parentId?: string } | null;
    const parentId = meta?.parentId;
    const payload: { text: string; reply?: { in_reply_to_tweet_id: string } } = { text: input.text };
    if (parentId) payload.reply = { in_reply_to_tweet_id: parentId };
    const resp = await fetch(TWEET_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.account.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.text();
      // X moved many endpoints to a credit/quota system in 2024. Free tier
      // posts ARE limited (500/month app-wide cap) — and "free for 500 users"
      // doesn't exist as a plan. A 402 with type=/2/problems/credits means
      // either the app's monthly post quota is exhausted (Free / Basic) or
      // the paid wallet is empty. Surface the actionable hint upstream so
      // the published-modal can render a "Upgrade or wait until next month"
      // path instead of a wall of JSON.
      if (resp.status === 402 && /credits|CreditsDepleted|\/problems\/credits/i.test(body)) {
        throw new PlatformError(
          'x_credits_depleted',
          402,
          'X (Twitter) API credits exhausted for this app. The Free tier caps posts at ~500/month app-wide; the Basic tier ($200/mo) raises that. Check developer.x.com → Projects & Apps → Usage. Detail: ' + body.slice(0, 400),
        );
      }
      throw new PlatformError('x_publish_failed', resp.status, body);
    }
    const data = (await resp.json()) as { data: { id: string; text: string } };
    return {
      platformPostId: data.data.id,
      url: `https://x.com/i/web/status/${data.data.id}`,
      raw: data,
    };
  },
};

function toS256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
