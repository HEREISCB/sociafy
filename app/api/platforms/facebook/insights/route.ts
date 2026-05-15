import { NextRequest } from 'next/server';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../../lib/api';
import { db } from '../../../../../lib/db';
import { connectedAccounts, scheduledPosts } from '../../../../../lib/db/schema';

const GRAPH = 'https://graph.facebook.com/v23.0';

// POST /api/platforms/facebook/insights
// Fetches reactions + comments + shares for every published Facebook post the
// current user has in scheduled_posts, updates the engagement jsonb field, and
// returns the freshly synced rows.
export async function POST(_req: NextRequest) {
  return withUser(async (user) => {
    const [acct] = await db()
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.platform, 'facebook')))
      .limit(1);
    if (!acct || acct.isStub || acct.accessToken === 'stub') {
      return jsonError('not_connected', 404);
    }

    const posts = await db()
      .select()
      .from(scheduledPosts)
      .where(and(
        eq(scheduledPosts.userId, user.id),
        eq(scheduledPosts.platform, 'facebook'),
        eq(scheduledPosts.status, 'published'),
        isNotNull(scheduledPosts.platformPostId),
      ))
      .orderBy(desc(scheduledPosts.publishedAt))
      .limit(20);

    if (posts.length === 0) return { synced: 0, posts: [] };

    const token = acct.accessToken;
    const results: Array<{
      id: string;
      platformPostId: string;
      url: string | null;
      text: string;
      publishedAt: string | null;
      engagement: { likes: number; comments: number; shares: number; lastSyncedAt: string };
    }> = [];

    await Promise.all(
      posts.map(async (p) => {
        if (!p.platformPostId) return;
        try {
          const url = `${GRAPH}/${p.platformPostId}?fields=reactions.summary(true),comments.summary(true),shares&access_token=${token}`;
          const resp = await fetch(url);
          if (!resp.ok) return;
          const data = (await resp.json()) as {
            reactions?: { summary?: { total_count?: number } };
            comments?: { summary?: { total_count?: number } };
            shares?: { count?: number };
          };
          const engagement = {
            likes: data.reactions?.summary?.total_count ?? 0,
            comments: data.comments?.summary?.total_count ?? 0,
            shares: data.shares?.count ?? 0,
            lastSyncedAt: new Date().toISOString(),
          };
          await db()
            .update(scheduledPosts)
            .set({ engagement, updatedAt: new Date() })
            .where(eq(scheduledPosts.id, p.id));
          results.push({
            id: p.id,
            platformPostId: p.platformPostId,
            url: p.platformPostUrl,
            text: p.text,
            publishedAt: p.publishedAt?.toISOString() ?? null,
            engagement,
          });
        } catch {
          // best-effort per post
        }
      }),
    );

    results.sort((a, b) => {
      const ta = a.publishedAt ? +new Date(a.publishedAt) : 0;
      const tb = b.publishedAt ? +new Date(b.publishedAt) : 0;
      return tb - ta;
    });
    return { synced: results.length, posts: results };
  });
}

// GET /api/platforms/facebook/insights
// Returns the cached engagement (no live fetch) for the user's published FB posts.
export async function GET() {
  return withUser(async (user) => {
    const posts = await db()
      .select()
      .from(scheduledPosts)
      .where(and(
        eq(scheduledPosts.userId, user.id),
        eq(scheduledPosts.platform, 'facebook'),
        eq(scheduledPosts.status, 'published'),
      ))
      .orderBy(desc(scheduledPosts.publishedAt))
      .limit(20);

    return {
      posts: posts.map((p) => ({
        id: p.id,
        platformPostId: p.platformPostId,
        url: p.platformPostUrl,
        text: p.text,
        publishedAt: p.publishedAt?.toISOString() ?? null,
        engagement: p.engagement ?? { likes: 0, comments: 0, shares: 0 },
      })),
    };
  });
}
