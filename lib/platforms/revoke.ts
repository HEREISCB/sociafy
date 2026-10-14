import { and, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { connectedAccounts, type Platform } from '../db/schema';
import { env } from '../env';
import { GRAPH } from './meta';

/**
 * Best-effort: tell the platform to invalidate the access/refresh tokens
 * for an account being disconnected. Most platforms expose a revocation
 * endpoint; for ones that don't, the tokens stay valid at the platform
 * side until natural expiry — but we've already deleted them locally so
 * they can't be used from this app.
 *
 * Failures are silently swallowed (logged). Disconnect must always succeed
 * locally even if the platform call errors.
 */
export async function revokeAtPlatform(
  platform: Platform,
  tokens: { accessToken: string; refreshToken: string | null },
  /** The connected_accounts row being disconnected (excluded from the
   *  shared-grant check in revokeFacebook). */
  accountId: string,
): Promise<void> {
  try {
    switch (platform) {
      case 'x':
        await revokeX(tokens.accessToken);
        return;
      case 'youtube':
        await revokeGoogle(tokens.refreshToken ?? tokens.accessToken);
        return;
      case 'tiktok':
        await revokeTikTok(tokens.accessToken);
        return;
      case 'linkedin':
        await revokeLinkedIn(tokens.accessToken);
        return;
      case 'facebook':
        await revokeFacebook(tokens.accessToken, accountId);
        return;
      case 'instagram':
        // Instagram API with Instagram Login documents no revoke / DELETE
        // permissions endpoint on graph.instagram.com (the FB-style DELETE
        // returns "Unsupported delete request"). Users revoke from Instagram
        // settings; the long-lived token lapses at its 60-day expiry.
        console.warn('[revoke] instagram: no revoke endpoint for Instagram Login tokens; skipped');
        return;
    }
  } catch (e) {
    console.warn('[revoke]', platform, e instanceof Error ? e.message : String(e));
  }
}

async function revokeX(token: string) {
  if (!env.platforms.x.clientId || !env.platforms.x.clientSecret) return;
  const basic = Buffer.from(`${env.platforms.x.clientId}:${env.platforms.x.clientSecret}`).toString('base64');
  await fetch('https://api.twitter.com/2/oauth2/revoke', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
  });
}

async function revokeGoogle(token: string) {
  // Google's revoke endpoint accepts either an access or refresh token.
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function revokeTikTok(token: string) {
  if (!env.platforms.tiktok.clientKey || !env.platforms.tiktok.clientSecret) return;
  await fetch('https://open.tiktokapis.com/v2/oauth/revoke/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: env.platforms.tiktok.clientKey,
      client_secret: env.platforms.tiktok.clientSecret,
      token,
    }),
  });
}

async function revokeLinkedIn(token: string) {
  if (!env.platforms.linkedin.clientId || !env.platforms.linkedin.clientSecret) return;
  await fetch('https://www.linkedin.com/oauth/v2/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token,
      client_id: env.platforms.linkedin.clientId,
      client_secret: env.platforms.linkedin.clientSecret,
    }),
  });
}

/**
 * Facebook: we store a PAGE token, so DELETE /me/permissions (which needs a
 * user token) resolved to the Page and did nothing. Instead, recover the
 * granting user's id via /debug_token and DELETE /{user-id}/permissions with
 * the app access token, which Meta accepts for the current app:
 * https://developers.facebook.com/docs/graph-api/reference/user/permissions/
 * https://developers.facebook.com/docs/graph-api/reference/debug_token/
 * Still best-effort: if debug_token has no user_id we warn and stop.
 *
 * DELETE /{user-id}/permissions drops EVERY grant that FB user gave this app,
 * so skip it while any other connected account (any Sociafy user) still
 * rides on the same FB user — revoking would silently break those.
 */
async function revokeFacebook(pageToken: string, accountId: string) {
  const { appId, appSecret } = env.platforms.meta;
  if (!appId || !appSecret) return;
  const appToken = `${appId}|${appSecret}`;
  const dbg = await fetch(
    `${GRAPH}/debug_token?input_token=${encodeURIComponent(pageToken)}&access_token=${encodeURIComponent(appToken)}`,
  );
  if (!dbg.ok) throw new Error(`debug_token ${dbg.status}: ${await dbg.text()}`);
  const userId = ((await dbg.json()) as { data?: { user_id?: string } }).data?.user_id;
  if (!userId) throw new Error('debug_token returned no user_id; permissions not revoked');
  const [shared] = await db()
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(and(
      inArray(connectedAccounts.platform, ['facebook', 'instagram']),
      sql`${connectedAccounts.meta}->>'userId' = ${userId}`,
      ne(connectedAccounts.id, accountId),
    ))
    .limit(1);
  if (shared) {
    console.warn(`[revoke] facebook: FB user ${userId} still backs connected account ${shared.id}; permissions not revoked`);
    return;
  }
  const resp = await fetch(`${GRAPH}/${userId}/permissions?access_token=${encodeURIComponent(appToken)}`, {
    method: 'DELETE',
  });
  if (!resp.ok) throw new Error(`DELETE permissions ${resp.status}: ${await resp.text()}`);
}
