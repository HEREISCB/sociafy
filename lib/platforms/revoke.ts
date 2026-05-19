import type { Platform } from '../db/schema';
import { env } from '../env';

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
      case 'instagram':
        await revokeMeta(tokens.accessToken);
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

async function revokeMeta(token: string) {
  // Meta's "revoke" is a DELETE on /me/permissions which invalidates all
  // permissions our app holds for the user.
  await fetch(`https://graph.facebook.com/v19.0/me/permissions`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}
