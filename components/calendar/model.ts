import type { Platform } from '../../lib/db/schema';

export type ScheduledStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';

export type ScheduledRow = {
  id: string;
  draftId: string;
  accountId: string | null;
  platform: Platform;
  scheduledAt: string;
  status: ScheduledStatus;
  text: string;
  platformPostUrl?: string | null;
  error?: string | null;
};

/** One post as the user thinks of it: a draft's per-platform rows that share a
 *  time and a status. Actions apply to every row in the group. */
export type PostGroup = {
  key: string;
  rows: ScheduledRow[];
  at: Date;
  status: ScheduledStatus;
  platforms: Platform[];
  text: string;
  error: string | null;
  url: string | null;
  /** The account was disconnected: the cron would fail it with no_account. */
  accountGone: boolean;
};

/** A planned draft that hasn't been approved yet (GET /api/plan → review[]). */
export type ReviewItem = { id: string; title: string | null; body: string; plannedAt: string | null; overdue: boolean; targetPlatforms: Platform[] | null };

export function groupRows(rows: ScheduledRow[]): PostGroup[] {
  const map = new Map<string, PostGroup>();
  for (const r of rows) {
    const key = `${r.draftId}|${r.scheduledAt}|${r.status}`;
    const g = map.get(key);
    if (g) {
      g.rows.push(r);
      g.platforms.push(r.platform);
      g.error ??= r.error ?? null;
      g.url ??= r.platformPostUrl ?? null;
      g.accountGone ||= isGone(r);
    } else {
      map.set(key, {
        key,
        rows: [r],
        at: new Date(r.scheduledAt),
        status: r.status,
        platforms: [r.platform],
        text: r.text,
        error: r.error ?? null,
        url: r.platformPostUrl ?? null,
        accountGone: isGone(r),
      });
    }
  }
  return [...map.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

const isGone = (r: ScheduledRow) => !r.accountId && (r.status === 'pending' || r.status === 'failed');

export const firstLine = (text: string) => text.trim().split('\n')[0] || '(empty)';

/** Only a post the user canceled may be restored: one Post now already sent,
 *  or one canceled by an account disconnect, would publish twice (the API 409s). */
export const restorable = (g: PostGroup) => g.status === 'canceled' && g.error === 'user_canceled';

export const needsAttention = (g: PostGroup) => g.status === 'failed' || g.accountGone;
