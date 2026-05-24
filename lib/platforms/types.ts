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

/** Shape of a connected_accounts row as passed into adapter methods. Tokens
 *  arrive already decrypted by ensureFreshToken; never persist this object. */
export type AdapterAccount = {
  id: string;
  accessToken: string;
  refreshToken?: string | null;
  platformUserId: string;
  meta?: Record<string, unknown> | null;
};

export type PublishInput = {
  text: string;
  media?: { url: string; mimeType: string }[];
  account: AdapterAccount;
};

export type PublishResult = {
  platformPostId: string;
  url?: string | null;
  raw?: unknown;
};

/** Outcome of polling a deferred publish (Instagram container, TikTok
 *  publish_id, etc.) until terminal state. */
export type WaitForPublishResult = {
  ok: boolean;
  lastStatus?: string;
  attempts: number;
  error?: string;
};

export type PostEngagement = {
  likes: number;
  comments: number;
  shares: number;
};

export type RecentPost = {
  id: string;
  message: string;
  createdAt: string;
  url: string | null;
  image: string | null;
  engagement: PostEngagement;
};

/** Read-only page/channel snapshot returned by adapter.fetchPageInfo. */
export type PageInfo = {
  id: string;
  name: string;
  username?: string | null;
  about?: string | null;
  category?: string | null;
  link?: string | null;
  avatarUrl?: string | null;
  followerCount: number;
  recentPosts: RecentPost[];
};

export interface PlatformAdapter {
  id: Platform;
  label: string;
  scopes: string[];
  isConfigured(): boolean;
  buildAuthorizeUrl(args: { redirectUri: string; state: string; codeVerifier?: string }): string;
  exchangeCode(args: { code: string; redirectUri: string; codeVerifier?: string }): Promise<{ tokens: OAuthTokens; profile: PlatformProfile }>;
  refresh?(refreshToken: string): Promise<OAuthTokens>;
  /**
   * Decide whether the token should be refreshed given how long until expiry.
   * Long-lived tokens (Instagram 60d) return true ~14d before expiry; short-
   * lived (X 2h, YouTube 1h) wait until ~5min remaining. When omitted, the
   * default policy refreshes when ≤ 5 minutes remain.
   */
  shouldRefresh?(remainingMs: number): boolean;
  publishText(input: PublishInput): Promise<PublishResult>;
  /** Optional: poll a deferred publish (Instagram media container, TikTok
   *  publish_id) until ready or terminal. Adapters that publish synchronously
   *  don't implement this. */
  waitForPublish?(args: { publishId: string; account: AdapterAccount }): Promise<WaitForPublishResult>;
  /** Optional: fetch the connected page/channel snapshot + recent posts.
   *  Only platforms with a public read API (Facebook today) implement this. */
  fetchPageInfo?(account: AdapterAccount): Promise<PageInfo>;
  /** Optional: fetch engagement counts for a single published post. */
  fetchPostEngagement?(args: { account: AdapterAccount; platformPostId: string }): Promise<PostEngagement>;
}

/** Normalized webhook event emitted by a WebhookAdapter's parse(). The
 *  shared route handler maps each event to a connected_accounts row by
 *  (platform, platformUserId) and writes it to activity_log. */
export type WebhookEvent = {
  /** Platform the event is FOR — may differ from the adapter that received
   *  it (the Meta endpoint receives both `facebook` and `instagram` events). */
  platform: Platform;
  /** Stable idempotency key (e.g. sha256(rawBody).slice(0,32) or a vendor id). */
  eventId: string;
  /** platform_user_id used to map this event to a connected_accounts row. */
  platformUserId?: string;
  /** Human-readable label shown in the activity feed. */
  title: string;
  /** Optional one-line summary stored as activity_log.body. */
  body?: string;
  /** Original payload — persisted in activity_log.meta for inspection. */
  payload: unknown;
};

export interface WebhookAdapter {
  /** Endpoint label, used in logs only. */
  id: string;
  /** Required env (e.g. INSTAGRAM_APP_SECRET) — if missing, verify() returns
   *  false and the handler responds with 401. */
  isConfigured(): boolean;
  /** Some providers (Meta/Instagram) use a GET challenge handshake during
   *  webhook setup. Returns the string to echo back, or null when this
   *  request isn't a verification ping. */
  challenge?(searchParams: URLSearchParams): string | null;
  /** Verify the request's signature against the raw body. */
  verify(args: { rawBody: string; headers: Headers }): boolean;
  /** Parse the raw body into 0+ normalized events. Returning [] is fine
   *  for noise (unknown object types, malformed JSON, etc.). */
  parse(rawBody: string): WebhookEvent[];
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
