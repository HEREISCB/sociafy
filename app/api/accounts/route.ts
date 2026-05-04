import { NextRequest } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { db } from '../../../lib/db';
import { connectedAccounts, PLATFORMS, type Platform } from '../../../lib/db/schema';

export async function GET() {
  return withUser(async (user) => {
    const rows = await db()
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, user.id))
      .orderBy(desc(connectedAccounts.createdAt));
    return rows;
  });
}

// POST is reserved for stub-mode connections only.
// Real OAuth flows live at /api/oauth/[platform]/start.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const body = await req.json();
    const platform = body?.platform as Platform | undefined;
    if (!platform || !PLATFORMS.includes(platform)) {
      return jsonError('invalid_platform');
    }
    const handle = body?.handle || `you-on-${platform}`;
    const [row] = await db()
      .insert(connectedAccounts)
      .values({
        userId: user.id,
        platform,
        platformUserId: `stub-${platform}-${user.id.slice(0, 8)}`,
        handle,
        displayName: handle,
        accessToken: 'stub',
        isStub: true,
      })
      .returning();
    return row;
  });
}
