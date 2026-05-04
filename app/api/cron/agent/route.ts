import { NextRequest, NextResponse } from 'next/server';
import { and, eq, desc, gte } from 'drizzle-orm';
import { checkCronAuth } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import {
  agentSettings,
  trends,
  drafts,
  scheduledPosts,
  connectedAccounts,
  activityLog,
  type Platform,
  type DraftMedia,
} from '../../../../lib/db/schema';
import { isStubMode } from '../../../../lib/env';
import { draftFromTrends } from '../../../../lib/ai/agent';
import { nextPostingWindow } from '../../../../lib/schedule/windows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (isStubMode.database()) return NextResponse.json({ skipped: 'no_database' });

  const enabled = await db().select().from(agentSettings).where(eq(agentSettings.enabled, true)).limit(100);

  const out: Array<{ userId: string; drafted: number; published: number; held: number; reason?: string }> = [];

  for (const settings of enabled) {
    // Per-user budget: drafts produced in the past 7 days
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = await db()
      .select()
      .from(drafts)
      .where(and(eq(drafts.userId, settings.userId), eq(drafts.source, 'agent'), gte(drafts.createdAt, since)));
    if (recent.length >= settings.cadencePerWeek) {
      out.push({ userId: settings.userId, drafted: 0, published: 0, held: 0, reason: 'budget_met' });
      continue;
    }

    // Pull fresh trends
    const newTrends = await db()
      .select()
      .from(trends)
      .where(and(eq(trends.userId, settings.userId), eq(trends.status, 'new')))
      .orderBy(desc(trends.score), desc(trends.capturedAt))
      .limit(8);
    if (newTrends.length === 0) {
      out.push({ userId: settings.userId, drafted: 0, published: 0, held: 0, reason: 'no_trends' });
      continue;
    }

    // User's connected platforms — only target what's connected
    const accounts = await db()
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, settings.userId));
    const connectedPlatforms = Array.from(new Set(accounts.map((a) => a.platform))) as Platform[];
    if (connectedPlatforms.length === 0) {
      out.push({ userId: settings.userId, drafted: 0, published: 0, held: 0, reason: 'no_accounts' });
      continue;
    }

    const drafted = await draftFromTrends({
      instructions: settings.instructions,
      voiceTemplate: (settings.voiceTemplate ?? 'me') as 'me' | 'punchy' | 'thoughtful' | 'data-led',
      niches: (settings.niches ?? []) as ('saas' | 'creator-economy' | 'marketing' | 'ai' | 'design' | 'devtools' | 'fintech' | 'media' | 'community')[],
      platforms: connectedPlatforms,
      brandSafetyStrict: settings.brandSafetyStrict,
      trends: newTrends.map((t) => ({ id: t.id, niche: t.niche, title: t.title, summary: t.summary, sourceUrl: t.sourceUrl })),
      count: Math.min(2, settings.cadencePerWeek - recent.length),
    });

    let publishedCount = 0;
    let heldCount = 0;

    for (const d of drafted) {
      const [draftRow] = await db()
        .insert(drafts)
        .values({
          userId: settings.userId,
          title: d.title,
          body: d.body,
          variants: [{ label: 'A', text: d.body, score: d.score, rationale: d.rationale }],
          selectedVariantLabel: 'A',
          targetPlatforms: connectedPlatforms,
          perPlatformText: d.perPlatform,
          source: 'agent',
        })
        .returning();

      // Mark trend as used
      if (d.trendId) {
        await db()
          .update(trends)
          .set({ status: 'used', usedInDraftId: draftRow.id })
          .where(eq(trends.id, d.trendId));
      }

      const accountByPlatform = new Map(accounts.map((a) => [a.platform, a]));

      if (d.score >= settings.autoPublishThreshold) {
        const when = nextPostingWindow(new Date(), settings.quietHours);
        for (const p of connectedPlatforms) {
          const acct = accountByPlatform.get(p);
          if (!acct) continue;
          await db().insert(scheduledPosts).values({
            userId: settings.userId,
            draftId: draftRow.id,
            accountId: acct.id,
            platform: p,
            scheduledAt: when,
            text: d.perPlatform[p] ?? d.body,
            media: [] as DraftMedia[],
          });
        }
        await db().update(drafts).set({ status: 'scheduled' }).where(eq(drafts.id, draftRow.id));
        await db().insert(activityLog).values({
          userId: settings.userId,
          kind: 'auto_publish',
          title: `Agent scheduled: ${d.title}`,
          body: d.body.slice(0, 280),
          meta: { draftId: draftRow.id, score: d.score, scheduledAt: when.toISOString() },
        });
        publishedCount++;
      } else {
        await db().insert(activityLog).values({
          userId: settings.userId,
          kind: 'agent_drafted',
          title: `Agent drafted: ${d.title}`,
          body: d.body.slice(0, 280),
          meta: { draftId: draftRow.id, score: d.score, threshold: settings.autoPublishThreshold },
        });
        heldCount++;
      }
    }

    await db().update(agentSettings).set({ lastRunAt: new Date() }).where(eq(agentSettings.userId, settings.userId));
    out.push({ userId: settings.userId, drafted: drafted.length, published: publishedCount, held: heldCount });
  }

  return NextResponse.json({ users: out });
}
