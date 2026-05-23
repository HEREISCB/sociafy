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
    const token = input.account.accessToken;

    // If the user attached media, we register the asset with LinkedIn,
    // PUT the binary from R2 into the resulting uploadUrl, then reference
    // the asset URN in the UGC post. Before this change we silently
    // dropped the media and posted text-only — that was the LinkedIn-video
    // bug the user hit.
    let mediaBlock: {
      shareMediaCategory: 'IMAGE' | 'VIDEO';
      media: Array<{ status: 'READY'; media: string; title?: { text: string } }>;
    } | null = null;

    const firstMedia = input.media?.[0];
    if (firstMedia) {
      const isVideo = firstMedia.mimeType.startsWith('video/');
      const recipe = isVideo
        ? 'urn:li:digitalmediaRecipe:feedshare-video'
        : 'urn:li:digitalmediaRecipe:feedshare-image';
      try {
        const assetUrn = await uploadLinkedInAsset({
          token,
          author,
          recipe,
          sourceUrl: firstMedia.url,
        });
        mediaBlock = {
          shareMediaCategory: isVideo ? 'VIDEO' : 'IMAGE',
          media: [{ status: 'READY', media: assetUrn, title: { text: input.text.slice(0, 80) } }],
        };
      } catch (e) {
        // We could fall back to text-only here, but silent degradation was
        // exactly the bug. Surface the failure so the user knows.
        const msg = e instanceof Error ? e.message : String(e);
        throw new PlatformError('linkedin_media_upload_failed', 502, msg);
      }
    }

    const body = {
      author,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: input.text },
          shareMediaCategory: mediaBlock ? mediaBlock.shareMediaCategory : 'NONE',
          ...(mediaBlock ? { media: mediaBlock.media } : {}),
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    };
    const resp = await fetch(POST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
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

/**
 * LinkedIn's three-step asset upload:
 *   1. POST /v2/assets?action=registerUpload — get an uploadUrl + asset URN
 *   2. PUT the binary into uploadUrl
 *   3. (Implicit) LinkedIn marks the asset AVAILABLE; UGC post references it
 *
 * The asset URN looks like "urn:li:digitalmediaAsset:C5605AQ...". The UGC
 * post takes shareMediaCategory: IMAGE|VIDEO with media: [{ status: 'READY',
 * media: <urn> }]. We do NOT poll for AVAILABLE here — for images and
 * short reels the post API tolerates a brief processing window, and
 * polling adds more failure modes than it removes. If LinkedIn rejects
 * the post with INVALID_MEDIA_STATE we'll add polling at that point.
 */
async function uploadLinkedInAsset(args: {
  token: string;
  author: string;
  recipe: string;
  sourceUrl: string;
}): Promise<string> {
  // 1. Register
  const registerResp = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: [args.recipe],
        owner: args.author,
        serviceRelationships: [
          { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' },
        ],
      },
    }),
  });
  if (!registerResp.ok) {
    throw new PlatformError('linkedin_register_upload_failed', registerResp.status, await registerResp.text());
  }
  const reg = (await registerResp.json()) as {
    value: {
      uploadMechanism: {
        'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: string };
      };
      asset: string;
    };
  };
  const uploadUrl = reg.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  const assetUrn = reg.value.asset;

  // 2. Fetch the binary from our R2 URL, then PUT to LinkedIn's uploadUrl.
  //    Using fetch's default agent is fine here — both hops are public CDNs.
  const srcResp = await fetch(args.sourceUrl);
  if (!srcResp.ok) {
    throw new PlatformError('linkedin_source_fetch_failed', srcResp.status, `Couldn't fetch ${args.sourceUrl}`);
  }
  const blob = await srcResp.arrayBuffer();

  const putResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${args.token}` },
    body: blob,
  });
  if (!putResp.ok && putResp.status !== 201) {
    throw new PlatformError('linkedin_upload_put_failed', putResp.status, await putResp.text());
  }
  return assetUrn;
}
