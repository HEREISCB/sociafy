import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, drafts, scheduledPosts, connectedAccounts, activityLog, type Platform, type DraftMedia } from '../db/schema';
import { nextPostingWindow } from '../schedule/windows';
import { postKind, supportsKind } from '../platforms/capabilities';

type Settings = typeof agentSettings.$inferSelect;
type Draft = typeof drafts.$inferSelect;

/**
 * Decide what happens to a finished autopilot draft: queue it to post on its
 * own, or leave it for the user. Called when the draft is written and — for
 * video — again when the render lands, so both paths obey the same rules.
 *
 * Returns true when at least one post was queued.
 */
export async function publishOrHold(settings: Settings, draft: Draft, score: number): Promise<boolean> {
  const userId = draft.userId;
  const media = (draft.media ?? []) as DraftMedia[];
  const log = (kind: 'auto_publish' | 'agent_drafted', title: string, meta: Record<string, unknown>) =>
    db().insert(activityLog).values({ userId, kind, title, body: draft.body.slice(0, 280), meta: { draftId: draft.id, score, ...meta } });

  // A paused agent never schedules a live post, and score 0 means "unrated"
  // (placeholder draft, or a model reply we couldn't trust) — it never
  // auto-publishes, even if the threshold is set to 0.
  if (!settings.enabled || score <= 0 || score < settings.autoPublishThreshold) {
    await log('agent_drafted', `Agent drafted: ${draft.title}`, { threshold: settings.autoPublishThreshold });
    return false;
  }

  const accounts = await db().select().from(connectedAccounts).where(eq(connectedAccounts.userId, userId));
  const accountByPlatform = new Map(accounts.map((a) => [a.platform, a]));

  // This week's scheduled-or-published posts per platform, for postsPerWeekByPlatform.
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recent = await db()
    .select({ platform: scheduledPosts.platform })
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.userId, userId), gte(scheduledPosts.createdAt, weekAgo)));
  const used = new Map<Platform, number>();
  for (const r of recent) used.set(r.platform as Platform, (used.get(r.platform as Platform) ?? 0) + 1);
  const caps = (settings.postsPerWeekByPlatform ?? {}) as Partial<Record<Platform, number>>;

  const kind = postKind(media);
  const when = nextPostingWindow(new Date(), settings.quietHours);
  const skipped: Platform[] = [];
  let queued = false;
  for (const p of (draft.targetPlatforms ?? []) as Platform[]) {
    const acct = accountByPlatform.get(p);
    if (!acct) continue;
    const cap = caps[p];
    // Over the weekly cap, or a post this platform's API rejects outright
    // (text to Instagram, anything but video to TikTok/YouTube).
    if ((typeof cap === 'number' && (used.get(p) ?? 0) >= cap) || !supportsKind(p, kind)) {
      skipped.push(p);
      continue;
    }
    await db().insert(scheduledPosts).values({
      userId,
      draftId: draft.id,
      accountId: acct.id,
      platform: p,
      scheduledAt: when,
      text: draft.perPlatformText?.[p] ?? draft.body,
      media,
    });
    queued = true;
  }

  // Nothing queued, so the draft is still a draft. Marking it 'scheduled' would
  // hide it from the review inbox and count it as published.
  if (!queued) {
    await log('agent_drafted', `Agent drafted: ${draft.title}`, { reason: 'no_platform_took_it', skipped });
    return false;
  }
  await db().update(drafts).set({ status: 'scheduled' }).where(eq(drafts.id, draft.id));
  await log('auto_publish', `Agent scheduled: ${draft.title}`, { scheduledAt: when.toISOString(), kind, skipped });
  return true;
}
