import { NextResponse } from 'next/server';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { shieldActions, mentions, scheduledPosts } from '../../../../lib/db/schema';
import { authedUser } from '../../../../lib/api';

export const runtime = 'nodejs';

// Unified "Needs your attention" queue: the things a user should act on now —
// crisis/negative mentions awaiting a response, and posts that failed to publish.
export async function GET() {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Pending crisis/negative responses, most severe first.
  const pending = await db()
    .select({
      id: shieldActions.id,
      status: shieldActions.status,
      mentionTitle: mentions.title,
      url: mentions.url,
      source: mentions.source,
      sentimentLabel: mentions.sentimentLabel,
      severity: mentions.severity,
      brand: mentions.brand,
    })
    .from(shieldActions)
    .innerJoin(mentions, eq(shieldActions.mentionId, mentions.id))
    .where(
      and(
        eq(shieldActions.userId, user.id),
        eq(shieldActions.status, 'pending'),
        inArray(mentions.sentimentLabel, ['crisis', 'negative']),
      ),
    )
    .orderBy(desc(mentions.severity))
    .limit(50);

  // Posts that failed to publish and need a retry.
  const failed = await db()
    .select({
      id: scheduledPosts.id,
      platform: scheduledPosts.platform,
      text: scheduledPosts.text,
      error: scheduledPosts.error,
      scheduledAt: scheduledPosts.scheduledAt,
    })
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.userId, user.id), eq(scheduledPosts.status, 'failed')))
    .orderBy(desc(scheduledPosts.scheduledAt))
    .limit(50);

  const crisisCount = pending.filter(p => p.sentimentLabel === 'crisis').length;

  return NextResponse.json({
    counts: {
      total: pending.length + failed.length,
      pendingResponses: pending.length,
      crisis: crisisCount,
      failedPosts: failed.length,
    },
    pendingResponses: pending.map(p => ({
      id: p.id,
      title: p.mentionTitle,
      url: p.url,
      source: p.source,
      sentimentLabel: p.sentimentLabel,
      severity: p.severity,
      brand: p.brand,
    })),
    failedPosts: failed.map(f => ({
      id: f.id,
      platform: f.platform,
      text: f.text.slice(0, 140),
      error: f.error,
      scheduledAt: f.scheduledAt ? f.scheduledAt.toISOString() : null,
    })),
  });
}
