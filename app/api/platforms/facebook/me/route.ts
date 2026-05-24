import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../../lib/api';
import { db } from '../../../../../lib/db';
import { connectedAccounts } from '../../../../../lib/db/schema';
import { env } from '../../../../../lib/env';
import { decryptToken } from '../../../../../lib/crypto/tokens';
import { facebookAdapter } from '../../../../../lib/platforms/meta';
import { PlatformError } from '../../../../../lib/platforms/types';

export async function GET(_req: NextRequest) {
  return withUser(async (user) => {
    const [acct] = await db()
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.platform, 'facebook')))
      .limit(1);

    if (!acct) return jsonError('not_connected', 404);
    if (acct.isStub || acct.accessToken === 'stub') {
      return {
        page: { id: acct.platformUserId, name: acct.handle ?? 'Stub page', isStub: true },
        followerCount: 0,
        recentPosts: [],
        stub: true,
      };
    }
    if (!env.platforms.meta.appId) {
      return jsonError('meta_not_configured', 503);
    }

    try {
      const info = await facebookAdapter.fetchPageInfo!({
        id: acct.id,
        accessToken: decryptToken(acct.accessToken) ?? acct.accessToken,
        refreshToken: acct.refreshToken,
        platformUserId: acct.platformUserId,
        meta: acct.meta,
      });
      return {
        stub: false,
        page: {
          id: info.id,
          name: info.name,
          username: info.username ?? null,
          about: info.about ?? null,
          category: info.category ?? null,
          link: info.link ?? null,
          avatarUrl: info.avatarUrl ?? null,
        },
        followerCount: info.followerCount,
        recentPosts: info.recentPosts.map((p) => ({
          id: p.id,
          message: p.message,
          createdAt: p.createdAt,
          url: p.url,
          image: p.image,
          likes: p.engagement.likes,
          comments: p.engagement.comments,
          shares: p.engagement.shares,
        })),
      };
    } catch (e) {
      // Don't relay raw Graph error body to the client — it can include
      // internal error codes/subcodes useful for enumeration.
      if (e instanceof PlatformError) {
        console.error('[graph]', e.status, e.detail);
        return jsonError('graph_page_failed', e.status);
      }
      throw e;
    }
  });
}
