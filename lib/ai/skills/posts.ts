import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../db';
import { scheduledPosts, drafts, type Platform } from '../../db/schema';
import type { ToolSpec } from '../agent-loop';

export type PostStat = {
  id: string;
  platform: Platform;
  text: string;
  publishedAt: string | null;
  url: string | null;
  likes: number;
  comments: number;
  shares: number;
  views: number;
};

export async function recentPublishedPosts(userId: string, limit = 12): Promise<PostStat[]> {
  const rows = await db()
    .select()
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.userId, userId),
        eq(scheduledPosts.status, 'published'),
        isNotNull(scheduledPosts.platformPostId),
      ),
    )
    .orderBy(desc(scheduledPosts.publishedAt))
    .limit(limit);

  return rows.map((r) => {
    const e = (r.engagement ?? {}) as { likes?: number; comments?: number; replies?: number; reposts?: number; shares?: number; views?: number };
    return {
      id: r.id,
      platform: r.platform,
      text: r.text.slice(0, 600),
      publishedAt: r.publishedAt?.toISOString() ?? null,
      url: r.platformPostUrl,
      likes: e.likes ?? 0,
      comments: e.comments ?? e.replies ?? 0,
      shares: e.shares ?? e.reposts ?? 0,
      views: e.views ?? 0,
    };
  });
}

export function readRecentPostsSkill(userId: string): ToolSpec {
  return {
    type: 'custom',
    def: {
      name: 'read_recent_posts',
      description:
        'Read the current user\'s most recent published posts across all platforms, along with engagement ' +
        'counts (likes, comments, shares, views). Use this to learn what topics and formats have been ' +
        'working before drafting something new.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max posts to return. Default 8, hard cap 24.' },
        },
      },
    },
    handler: async (input) => {
      const args = input as { limit?: number };
      const limit = Math.min(Math.max(args.limit ?? 8, 1), 24);
      const posts = await recentPublishedPosts(userId, limit);
      // Sort by engagement to surface the highest-signal posts first.
      posts.sort((a, b) => (b.likes + b.comments * 2 + b.shares * 3) - (a.likes + a.comments * 2 + a.shares * 3));
      return { count: posts.length, posts };
    },
  };
}

export async function recentDraftTopics(userId: string, limit = 20): Promise<string[]> {
  const rows = await db()
    .select({ title: drafts.title, body: drafts.body })
    .from(drafts)
    .where(eq(drafts.userId, userId))
    .orderBy(desc(drafts.createdAt))
    .limit(limit);
  return rows
    .map((r) => (r.title ?? r.body.slice(0, 80)).trim())
    .filter((s) => s.length > 0);
}

export function readRecentDraftsSkill(userId: string): ToolSpec {
  return {
    type: 'custom',
    def: {
      name: 'read_recent_drafts',
      description:
        'Read titles of the current user\'s recent drafts (published and unpublished). Use to avoid ' +
        'duplicating a topic the user has already written about recently.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    },
    handler: async (input) => {
      const args = input as { limit?: number };
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 40);
      const topics = await recentDraftTopics(userId, limit);
      return { count: topics.length, topics };
    },
  };
}
