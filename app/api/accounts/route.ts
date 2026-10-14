import { NextRequest } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { db } from '../../../lib/db';
import { connectedAccounts, type Platform } from '../../../lib/db/schema';
import { encryptToken } from '../../../lib/crypto/tokens';
import { stubAccountCreateSchema, parseBody } from '../../../lib/validation';
import { getAdapter } from '../../../lib/platforms/registry';

// Strip access/refresh tokens from API responses — the client never needs them.
const PUBLIC_COLUMNS = {
  id: connectedAccounts.id,
  userId: connectedAccounts.userId,
  platform: connectedAccounts.platform,
  platformUserId: connectedAccounts.platformUserId,
  handle: connectedAccounts.handle,
  displayName: connectedAccounts.displayName,
  avatarUrl: connectedAccounts.avatarUrl,
  scope: connectedAccounts.scope,
  tokenExpiresAt: connectedAccounts.tokenExpiresAt,
  meta: connectedAccounts.meta,
  isStub: connectedAccounts.isStub,
  createdAt: connectedAccounts.createdAt,
  updatedAt: connectedAccounts.updatedAt,
} as const;

export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    // Read-only. Token refresh belongs to the refresh-tokens cron and the
    // publish paths — refreshing every account on each page load raced them
    // for X's single-use refresh tokens. Access/refresh fields are stripped
    // from the response below.
    const rows = await db()
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, user.id))
      .orderBy(desc(connectedAccounts.createdAt));

    return rows.map((row) => {
      const adapter = getAdapter(row.platform as Platform);
      const autoRefresh = !!adapter.refresh && row.refreshToken !== null && !row.isStub;
      return {
        id: row.id,
        userId: row.userId,
        platform: row.platform,
        platformUserId: row.platformUserId,
        handle: row.handle,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        scope: row.scope,
        tokenExpiresAt: row.tokenExpiresAt,
        meta: row.meta,
        isStub: row.isStub,
        autoRefresh,
        lastRefreshAt: row.lastRefreshAt,
        lastRefreshError: row.lastRefreshError,
        lastRefreshErrorAt: row.lastRefreshErrorAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }, req);
}

// POST is reserved for stub-mode connections only.
// Real OAuth flows live at /api/oauth/[platform]/start.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    // A stub account publishes to nowhere (every adapter short-circuits to
    // stubPublish on accessToken 'stub'), so minting one outside dev hands the
    // user a connection that silently swallows posts. Same gate as the stub
    // OAuth flow in /api/oauth/[platform]/start and SKIP_AUTH_DEV in lib/api.ts.
    if (process.env.NODE_ENV !== 'development') return jsonError('stub_accounts_disabled', 403);
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(stubAccountCreateSchema, raw);
    if (!parsed.ok) return parsed.response;
    const { platform } = parsed.data;
    const handle = parsed.data.handle || `you-on-${platform}`;
    const [row] = await db()
      .insert(connectedAccounts)
      .values({
        userId: user.id,
        platform,
        platformUserId: `stub-${platform}-${user.id.slice(0, 8)}`,
        handle,
        displayName: handle,
        accessToken: encryptToken('stub'),
        isStub: true,
      })
      .returning(PUBLIC_COLUMNS);
    return row;
  }, req);
}
