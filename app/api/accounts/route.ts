import { NextRequest } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { connectedAccounts, type Platform } from '../../../lib/db/schema';
import { encryptToken } from '../../../lib/crypto/tokens';
import { stubAccountCreateSchema, parseBody } from '../../../lib/validation';
import { ensureFreshToken } from '../../../lib/platforms/token';
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
    // Read the full row server-side so we can opportunistically refresh
    // expiring tokens. We strip access/refresh fields from the response.
    const rows = await db()
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, user.id))
      .orderBy(desc(connectedAccounts.createdAt));

    // Opportunistic refresh: every time the Connections page loads we run
    // each row through ensureFreshToken. Each adapter only actually swaps the
    // token when remaining < its refreshHorizonMs, so this is cheap for
    // tokens that don't need it. Net effect: even without an external cron
    // scheduler, tokens get refreshed when the user opens the dashboard.
    const refreshed = await Promise.all(rows.map((r) => ensureFreshToken(r).catch(() => r)));

    return refreshed.map((row) => {
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
