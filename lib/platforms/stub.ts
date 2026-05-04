import type { Platform } from '../db/schema';
import type { OAuthTokens, PlatformProfile, PublishInput, PublishResult } from './types';

export function stubProfile(platform: Platform, userId: string): { tokens: OAuthTokens; profile: PlatformProfile } {
  return {
    tokens: {
      accessToken: `stub-token-${platform}`,
      refreshToken: `stub-refresh-${platform}`,
      expiresAt: null,
      scope: 'stub',
      meta: { stub: true },
    },
    profile: {
      platformUserId: `stub-${platform}-${userId.slice(0, 8)}`,
      handle: `you-on-${platform}`,
      displayName: `You · ${platform}`,
      avatarUrl: null,
    },
  };
}

export async function stubPublish(input: PublishInput, platform: Platform): Promise<PublishResult> {
  const id = `stub-${platform}-${Date.now()}`;
  return {
    platformPostId: id,
    url: `https://stub.sociafy.local/${platform}/${id}`,
    raw: { stub: true, text: input.text.slice(0, 80) },
  };
}
