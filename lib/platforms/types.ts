import type { Platform } from '../db/schema';

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scope?: string | null;
  meta?: Record<string, unknown>;
};

export type PlatformProfile = {
  platformUserId: string;
  handle?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
};

export type PublishInput = {
  text: string;
  media?: { url: string; mimeType: string }[];
  account: {
    id: string;
    accessToken: string;
    refreshToken?: string | null;
    platformUserId: string;
    meta?: Record<string, unknown> | null;
  };
};

export type PublishResult = {
  platformPostId: string;
  url?: string | null;
  raw?: unknown;
};

export interface PlatformAdapter {
  id: Platform;
  label: string;
  scopes: string[];
  isConfigured(): boolean;
  buildAuthorizeUrl(args: { redirectUri: string; state: string; codeVerifier?: string }): string;
  exchangeCode(args: { code: string; redirectUri: string; codeVerifier?: string }): Promise<{ tokens: OAuthTokens; profile: PlatformProfile }>;
  refresh?(refreshToken: string): Promise<OAuthTokens>;
  publishText(input: PublishInput): Promise<PublishResult>;
}

export class PlatformError extends Error {
  status: number;
  detail?: unknown;
  constructor(message: string, status = 400, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
