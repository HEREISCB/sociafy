import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../../lib/api';
import { db } from '../../../../../lib/db';
import { connectedAccounts } from '../../../../../lib/db/schema';
import { env } from '../../../../../lib/env';

const GRAPH = 'https://graph.facebook.com/v23.0';

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

    const pageId = acct.platformUserId;
    const token = acct.accessToken;

    const [pageRes, postsRes] = await Promise.all([
      fetch(`${GRAPH}/${pageId}?fields=id,name,username,fan_count,followers_count,picture.type(large),link,about,category&access_token=${token}`),
      fetch(`${GRAPH}/${pageId}/posts?fields=id,message,created_time,permalink_url,full_picture,reactions.summary(true),comments.summary(true),shares&limit=5&access_token=${token}`),
    ]);

    if (!pageRes.ok) {
      const detail = await pageRes.text();
      return jsonError('graph_page_failed', pageRes.status, { detail });
    }

    const page = (await pageRes.json()) as {
      id: string;
      name: string;
      username?: string;
      fan_count?: number;
      followers_count?: number;
      picture?: { data?: { url?: string } };
      link?: string;
      about?: string;
      category?: string;
    };

    type RawPost = {
      id: string;
      message?: string;
      created_time: string;
      permalink_url?: string;
      full_picture?: string;
      reactions?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    };

    const posts: RawPost[] = postsRes.ok ? ((await postsRes.json()).data ?? []) : [];

    return {
      stub: false,
      page: {
        id: page.id,
        name: page.name,
        username: page.username ?? null,
        about: page.about ?? null,
        category: page.category ?? null,
        link: page.link ?? null,
        avatarUrl: page.picture?.data?.url ?? null,
      },
      followerCount: page.followers_count ?? page.fan_count ?? 0,
      recentPosts: posts.map((p) => ({
        id: p.id,
        message: p.message ?? '',
        createdAt: p.created_time,
        url: p.permalink_url ?? null,
        image: p.full_picture ?? null,
        likes: p.reactions?.summary?.total_count ?? 0,
        comments: p.comments?.summary?.total_count ?? 0,
        shares: p.shares?.count ?? 0,
      })),
    };
  });
}
