import crypto from 'crypto';
import { env } from '../env';
import type { PlatformAdapter, PublishInput, PublishResult } from './types';
import { PlatformError } from './types';
import { stubProfile, stubPublish } from './stub';

const AUTH_URL = 'https://twitter.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const ME_URL = 'https://api.twitter.com/2/users/me?user.fields=username,profile_image_url,name';
const TWEET_URL = 'https://api.twitter.com/2/tweets';
// v2 media upload (GA 2025). The old v1.1 upload.twitter.com endpoints are
// deprecated; this one takes an OAuth 2.0 user token like /2/tweets does.
const MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';
const MAX_MEDIA = 4; // X's per-tweet cap

export const xAdapter: PlatformAdapter = {
  id: 'x',
  label: 'X',
  // media.write is required by /2/media/upload. Accounts connected before it
  // was added get a 403 on media posts and must reconnect — that's a loud,
  // actionable failure, unlike the silent text-only post we used to send.
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
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
    const payload: {
      text: string;
      reply?: { in_reply_to_tweet_id: string };
      media?: { media_ids: string[] };
    } = { text: input.text };
    if (parentId) payload.reply = { in_reply_to_tweet_id: parentId };

    // Attached media used to be dropped here — the tweet went out text-only
    // with no error, after the user paid credits for the image.
    const media = input.media ?? [];
    if (media.length > 0) {
      if (media.length > MAX_MEDIA) {
        throw new PlatformError(
          'x_too_many_media',
          400,
          `X allows at most ${MAX_MEDIA} attachments per post; this one has ${media.length}.`,
        );
      }
      if (media.some((m) => m.mimeType.startsWith('video/'))) {
        // ponytail: video needs the chunked INIT/APPEND/FINALIZE flow plus
        // processing_info polling. Not implemented — fail loudly rather than
        // post the caption alone. Add chunked upload if users ask for X video.
        throw new PlatformError(
          'x_video_unsupported',
          400,
          'Posting video to X is not supported yet (only images). Remove the video or publish it to another platform.',
        );
      }
      const ids: string[] = [];
      for (const m of media) ids.push(await uploadXMedia(input.account.accessToken, m));
      payload.media = { media_ids: ids };
    }
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

/**
 * Fetch an image from our R2 URL and hand it to X's v2 media endpoint as
 * multipart/form-data. Returns the media id to reference in /2/tweets.
 * Single-request upload only — fine for images (≤5 MB), see the video guard
 * in publishText for why we don't try video here.
 */
async function uploadXMedia(token: string, m: { url: string; mimeType: string }): Promise<string> {
  const src = await fetch(m.url);
  if (!src.ok) {
    throw new PlatformError('x_media_source_fetch_failed', src.status, `Couldn't fetch ${m.url}`);
  }
  const form = new FormData();
  form.append('media', new Blob([await src.arrayBuffer()], { type: m.mimeType }), 'upload');
  form.append('media_category', 'tweet_image');
  const resp = await fetch(MEDIA_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }, // fetch sets the multipart boundary
    body: form,
  });
  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      throw new PlatformError(
        'x_media_scope_missing',
        403,
        'X rejected the image upload — the connected account is missing the media.write scope. Reconnect X on the Connections page. Detail: ' + body.slice(0, 300),
      );
    }
    throw new PlatformError('x_media_upload_failed', resp.status, body);
  }
  const j = (await resp.json()) as { data?: { id?: string }; media_id_string?: string };
  const id = j.data?.id ?? j.media_id_string;
  if (!id) throw new PlatformError('x_media_upload_failed', 502, 'upload returned no media id');
  return id;
}

function toS256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
