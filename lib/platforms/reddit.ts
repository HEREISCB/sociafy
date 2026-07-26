import { env } from '../env';
import type { PlatformAdapter, PublishInput, PublishResult } from './types';
import { PlatformError } from './types';
import { stubProfile, stubPublish } from './stub';

const AUTH_URL = 'https://www.reddit.com/api/v1/authorize';
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const ME_URL = 'https://oauth.reddit.com/api/v1/me';
const COMMENT_URL = 'https://oauth.reddit.com/api/comment';
const SUBMIT_URL = 'https://oauth.reddit.com/api/submit';

const UA = 'Sociafy/1.0 (by /u/SociafyBot)';

export const redditAdapter: PlatformAdapter = {
  id: 'reddit',
  label: 'Reddit',
  scopes: ['identity', 'read', 'submit'],
  isConfigured() {
    return !!env.platforms.reddit.clientId && !!env.platforms.reddit.clientSecret;
  },
  buildAuthorizeUrl({ redirectUri, state }) {
    if (!this.isConfigured()) return `/api/oauth/reddit/callback?stub=1&state=${state}`;
    const params = new URLSearchParams({
      client_id: env.platforms.reddit.clientId!,
      response_type: 'code',
      state,
      redirect_uri: redirectUri,
      duration: 'permanent',
      scope: this.scopes.join(' '),
    });
    return `${AUTH_URL}?${params.toString()}`;
  },
  async exchangeCode({ code, redirectUri }) {
    if (!this.isConfigured()) {
      return stubProfile('reddit', 'unknown');
    }
    const basic = Buffer.from(
      `${env.platforms.reddit.clientId}:${env.platforms.reddit.clientSecret}`,
    ).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body,
    });
    if (!tokenResp.ok) {
      throw new PlatformError('reddit_token_exchange_failed', tokenResp.status, await tokenResp.text());
    }
    const t = (await tokenResp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
    };
    if (t.error) {
      throw new PlatformError('reddit_token_exchange_failed', 400, t.error);
    }
    const tokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
      scope: t.scope ?? null,
    };
    const meResp = await fetch(ME_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, 'User-Agent': UA },
    });
    if (!meResp.ok) {
      throw new PlatformError('reddit_me_failed', meResp.status, await meResp.text());
    }
    const me = (await meResp.json()) as {
      id: string;
      name: string;
      icon_img?: string;
    };
    return {
      tokens,
      profile: {
        platformUserId: me.id,
        handle: me.name,
        displayName: me.name,
        avatarUrl: me.icon_img ? me.icon_img.split('?')[0] : null,
      },
    };
  },
  async refresh(refreshToken) {
    if (!this.isConfigured()) {
      return { accessToken: 'stub', refreshToken };
    }
    const basic = Buffer.from(
      `${env.platforms.reddit.clientId}:${env.platforms.reddit.clientSecret}`,
    ).toString('base64');
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!resp.ok) throw new PlatformError('reddit_refresh_failed', resp.status, await resp.text());
    const t = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? refreshToken,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
    };
  },
  async publishText(input: PublishInput): Promise<PublishResult> {
    if (!this.isConfigured() || input.account.accessToken === 'stub') {
      return stubPublish(input, 'reddit');
    }
    const meta = input.account.meta as { parentId?: string; subreddit?: string } | null;
    const parentId = meta?.parentId;
    const subreddit = meta?.subreddit;

    // We only ever submitted kind:'self', so any attachment was dropped
    // without a word. Reddit image posts need the asset-lease flow
    // (POST /api/media/asset.json → PUT to the returned S3 form → submit
    // kind:'image' with the websocket asset url), and comments can't carry
    // media at all outside richtext. Neither is implemented, so say so.
    // ponytail: implement the asset lease if image posts to Reddit get asked
    // for; a kind:'link' post to the raw R2 url is not the same thing and
    // many subreddits ban it.
    if (input.media && input.media.length > 0) {
      throw new PlatformError(
        'reddit_media_unsupported',
        400,
        'Reddit posting supports text only right now. Remove the attachment, or publish the image to another platform.',
      );
    }

    // If we have a parentId, this is a comment/reply on an existing thread
    if (parentId) {
      const resp = await fetch(COMMENT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.account.accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: new URLSearchParams({ api_type: 'json', text: input.text, thing_id: parentId }),
      });
      if (!resp.ok) {
        throw new PlatformError('reddit_comment_failed', resp.status, await resp.text());
      }
      const data = (await resp.json()) as { json?: { data?: { things?: [{ data?: { name?: string; id?: string } }] } } };
      const thing = data?.json?.data?.things?.[0]?.data;
      const id = thing?.name ?? thing?.id ?? 'unknown';
      return {
        platformPostId: id,
        url: `https://www.reddit.com/comments/${id}`,
        raw: data,
      };
    }

    // Otherwise, create a new text post in a subreddit
    if (!subreddit) {
      throw new PlatformError('reddit_publish_failed', 400, 'subreddit required for new post');
    }
    const resp = await fetch(SUBMIT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.account.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: new URLSearchParams({
        api_type: 'json',
        kind: 'self',
        sr: subreddit,
        title: `${input.text.slice(0, 300)}`,
        text: input.text,
      }),
    });
    if (!resp.ok) {
      throw new PlatformError('reddit_submit_failed', resp.status, await resp.text());
    }
    const data = (await resp.json()) as { json?: { data?: { id?: string; url?: string } } };
    const id = data?.json?.data?.id ?? 'unknown';
    const url = data?.json?.data?.url ?? `https://www.reddit.com/`;
    return { platformPostId: id, url, raw: data };
  },
};

/** Search Reddit for brand mentions using the OAuth search API.
 *  Returns raw hit objects — caller maps to RawMention shape. */
export async function searchRedditMentions(
  accessToken: string,
  query: string,
  limit = 25,
): Promise<RedditHit[]> {
  const q = encodeURIComponent(`"${query}"`);
  const resp = await fetch(
    `https://oauth.reddit.com/search?q=${q}&sort=new&limit=${limit}&type=link,comment`,
    {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA },
    },
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as { data?: { children?: { data: RedditHit }[] } };
  return (data?.data?.children ?? []).map((c) => c.data);
}

export type RedditHit = {
  id: string;
  name: string;
  title?: string;
  selftext?: string;
  body?: string;
  author?: string;
  subreddit?: string;
  url?: string;
  permalink?: string;
  score?: number;
  num_comments?: number;
  created_utc?: number;
};
