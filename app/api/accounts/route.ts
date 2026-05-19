import { NextRequest } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { connectedAccounts } from '../../../lib/db/schema';
import { encryptToken } from '../../../lib/crypto/tokens';
import { stubAccountCreateSchema, parseBody } from '../../../lib/validation';

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
    const rows = await db()
      .select(PUBLIC_COLUMNS)
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, user.id))
      .orderBy(desc(connectedAccounts.createdAt));
    return rows;
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
