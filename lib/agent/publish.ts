import { and, eq, gt, lte, notInArray } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, drafts, scheduledPosts, connectedAccounts, activityLog, type Platform, type DraftMedia } from '../db/schema';
import { nextPostingWindow } from '../schedule/windows';
import { postKind, supportsKind, unsupportedReason } from '../platforms/capabilities';
import { getAdapter } from '../platforms/registry';
import { cantPost } from '../ui/health';
import { postText } from './postText';
import { PLATFORM_LABELS } from '../ui/platforms';

export { postText };

type Settings = typeof agentSettings.$inferSelect;
type Draft = typeof drafts.$inferSelect;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Same verdict as the dashboard's "Reconnect" chip (lib/ui/health.ts), from the db row. */
const disconnected = (a: typeof connectedAccounts.$inferSelect) =>
  cantPost({
    isStub: a.isStub,
    tokenExpiresAt: a.tokenExpiresAt ? new Date(a.tokenExpiresAt).toISOString() : null,
    autoRefresh: !!getAdapter(a.platform as Platform).refresh && a.refreshToken !== null && !a.isStub,
    lastRefreshError: a.lastRefreshError,
  }, Date.now());

export type QueueResult = { queued: Platform[]; skipped: Platform[]; reasons: Record<string, string> };

/**
 * Turn a draft into scheduled posts at `at` — one per target platform that has
 * an account and whose API takes this kind of post (the same checks as
 * POST /api/schedule). `skipDisconnected` (Approve, and autopilot's own scheduling) also leaves out
 * accounts that need reconnecting: the cron would fail those posts for good at
 * their slot (lib/cron/publish.ts) and never retries them after a reconnect. `caps` = autopilot's per-platform weekly limits, counted
 * over the 7 days up to `at`. Marks the draft scheduled only if something was
 * queued, and only if it was still a draft — a double-approve queues once.
 */
export async function queueDraft(draft: Draft, at: Date, caps?: Partial<Record<Platform, number>>, skipDisconnected = false): Promise<QueueResult> {
  const userId = draft.userId;
  const media = (draft.media ?? []) as DraftMedia[];
  const kind = postKind(media);
  const accounts = await db().select().from(connectedAccounts).where(eq(connectedAccounts.userId, userId));
  const accountByPlatform = new Map(accounts.map((a) => [a.platform, a]));

  const used = new Map<Platform, number>();
  if (caps && Object.keys(caps).length) {
    const near = await db()
      .select({ platform: scheduledPosts.platform })
      .from(scheduledPosts)
      .where(and(
        eq(scheduledPosts.userId, userId),
        gt(scheduledPosts.scheduledAt, new Date(at.getTime() - WEEK_MS)),
        lte(scheduledPosts.scheduledAt, at),
        notInArray(scheduledPosts.status, ['failed', 'canceled']),
      ));
    for (const r of near) used.set(r.platform as Platform, (used.get(r.platform as Platform) ?? 0) + 1);
  }

  const reasons: Record<string, string> = {};
  const take: Platform[] = [];
  for (const p of (draft.targetPlatforms ?? []) as Platform[]) {
    const cap = caps?.[p];
    const acct = accountByPlatform.get(p);
    if (!acct) reasons[p] = `No connected account for ${p}. Connect it first, then schedule.`;
    else if (skipDisconnected && disconnected(acct)) reasons[p] = 'disconnected';
    else if (!supportsKind(p, kind)) reasons[p] = unsupportedReason(p, kind);
    else if (typeof cap === 'number' && (used.get(p) ?? 0) >= cap) reasons[p] = `Autopilot's weekly limit for ${p} is reached.`;
    else take.push(p);
  }
  const skipped = Object.keys(reasons) as Platform[];
  if (take.length === 0) return { queued: [], skipped, reasons };

  const [claimed] = await db()
    .update(drafts)
    .set({ status: 'scheduled', plannedAt: at, updatedAt: new Date() })
    .where(and(eq(drafts.id, draft.id), eq(drafts.userId, userId), eq(drafts.status, 'draft')))
    .returning({ id: drafts.id });
  if (!claimed) return { queued: [], skipped, reasons: { ...reasons, draft: 'not_a_draft' } };

  for (const p of take) {
    await db().insert(scheduledPosts).values({
      userId,
      draftId: draft.id,
      accountId: accountByPlatform.get(p)!.id,
      platform: p,
      scheduledAt: at,
      text: postText(draft, p),
      media,
    });
  }
  return { queued: take, skipped, reasons };
}

/**
 * Decide what happens to a finished autopilot draft: queue it to post on its
 * own, or leave it for the user. Called when the draft is written and — for
 * video — again when the render lands, so both paths obey the same rules.
 * It posts at the draft's planned slot; a slot already gone (a slow render)
 * moves to the next posting window.
 *
 * Returns true when at least one post was queued.
 */
export async function publishOrHold(settings: Settings, draft: Draft, score: number): Promise<boolean> {
  const userId = draft.userId;
  const log = (kind: 'auto_publish' | 'agent_drafted', title: string, meta: Record<string, unknown>) =>
    db().insert(activityLog).values({ userId, kind, title, body: draft.body.slice(0, 280), meta: { draftId: draft.id, score, ...meta } });

  // A paused agent never schedules a live post, and score 0 means "unrated"
  // (placeholder draft, or a model reply we couldn't trust) — it never
  // auto-publishes, even if the threshold is set to 0.
  if (!settings.enabled || score <= 0 || score < settings.autoPublishThreshold) {
    await log('agent_drafted', `Agent drafted: ${draft.title}`, { threshold: settings.autoPublishThreshold, plannedAt: draft.plannedAt });
    return false;
  }

  const now = new Date();
  const planned = draft.plannedAt ? new Date(draft.plannedAt) : null;
  const when = planned && planned.getTime() > now.getTime() + 5 * 60_000 ? planned : nextPostingWindow(now, settings.quietHours);
  // Same rule as the user's Approve: an account that needs reconnecting would
  // fail its post for good at the slot, so leave it out and say so.
  const { queued, skipped, reasons } = await queueDraft(draft, when, (settings.postsPerWeekByPlatform ?? {}) as Partial<Record<Platform, number>>, true);
  const gone = skipped.filter((p) => reasons[p] === 'disconnected');
  if (gone.length) {
    const names = gone.map((p) => PLATFORM_LABELS[p] ?? p).join(', ');
    await db().insert(activityLog).values({
      userId, kind: 'publish_warning',
      title: `Not posted to ${names}: reconnect ${gone.length > 1 ? 'them' : 'it'}`,
      body: `Autopilot left ${names} out of "${draft.title}" because the account needs reconnecting. Reconnect it in Settings → Connections; later posts will include it again.`,
      meta: { draftId: draft.id, platforms: gone },
    });
  }

  // Nothing queued, so the draft is still a draft. Marking it 'scheduled' would
  // hide it from the review inbox and count it as published.
  if (queued.length === 0) {
    await log('agent_drafted', `Agent drafted: ${draft.title}`, { reason: 'no_platform_took_it', skipped });
    return false;
  }
  await log('auto_publish', `Agent scheduled: ${draft.title}`, { scheduledAt: when.toISOString(), kind: postKind((draft.media ?? []) as DraftMedia[]), skipped });
  return true;
}
