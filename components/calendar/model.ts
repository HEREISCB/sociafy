import { format } from 'date-fns';
import type { DraftMedia, Platform } from '../../lib/db/schema';
import type { PlanView } from '../../lib/agent/plan';

export type ScheduledStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';

export type ScheduledRow = {
  id: string;
  draftId: string;
  accountId: string | null;
  platform: Platform;
  scheduledAt: string;
  status: ScheduledStatus;
  text: string;
  media?: DraftMedia[] | null;
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
  media: DraftMedia[];
  error: string | null;
  url: string | null;
  /** The account was disconnected: the cron would fail it with no_account. */
  accountGone: boolean;
};

/** A draft awaiting review (GET /api/plan → review[]). */
export type ReviewItem = PlanView['review'][number];

/** Anything Home shows on the calendar or in the "Needs a time" tray. */
export type CalItem =
  | { kind: 'draft'; key: string; at: Date | null; draft: ReviewItem }
  | { kind: 'post'; key: string; at: Date; group: PostGroup };

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
        media: r.media ?? [],
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

/** Dated drafts and scheduled posts, chronological. Undated drafts go to the tray. */
export function calendarItems(review: ReviewItem[], groups: PostGroup[]): CalItem[] {
  return [
    ...review.flatMap((d): CalItem[] => (d.plannedAt ? [{ kind: 'draft', key: `d${d.id}`, at: new Date(d.plannedAt), draft: d }] : [])),
    ...groups.map((g): CalItem => ({ kind: 'post', key: g.key, at: g.at, group: g })),
  ].sort((a, b) => a.at!.getTime() - b.at!.getTime());
}

/** yyyy-MM-dd → items that day, in time order. */
export function byDay(items: CalItem[]): Map<string, CalItem[]> {
  const m = new Map<string, CalItem[]>();
  for (const i of items) {
    if (!i.at) continue;
    const k = dayKey(i.at);
    m.set(k, [...(m.get(k) ?? []), i]);
  }
  return m;
}
export const dayKey = (d: Date) => format(d, 'yyyy-MM-dd');

/** Visual status: drives the card's styling and badge. */
export type Tone = 'review' | 'waiting' | 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';
export function toneOf(i: CalItem): Tone {
  if (i.kind === 'draft') return i.draft.approved ? 'waiting' : 'review';
  return i.group.accountGone ? 'failed' : i.group.status;
}

export const itemTitle = (i: CalItem) =>
  i.kind === 'draft' ? i.draft.title?.trim() || firstLine(i.draft.body) : firstLine(i.group.text);
export const itemMedia = (i: CalItem): DraftMedia | undefined => (i.kind === 'draft' ? i.draft.media[0] : i.group.media[0]);
export const itemPlatforms = (i: CalItem): Platform[] => (i.kind === 'draft' ? i.draft.targetPlatforms ?? [] : i.group.platforms);
export const isVideo = (m?: DraftMedia) => !!m?.mimeType?.startsWith('video/');

/** What can be dragged to another day: unapproved drafts and still-pending posts. */
export const movable = (i: CalItem) =>
  i.kind === 'draft' ? !i.draft.approved : i.group.status === 'pending' && !i.group.accountGone;

/** Same time of day on another date; a draft without a time lands at 10 AM. */
export function moveToDay(i: CalItem, day: Date): Date {
  const d = new Date(day);
  if (i.at) d.setHours(i.at.getHours(), i.at.getMinutes(), 0, 0);
  else d.setHours(10, 0, 0, 0);
  return d;
}

/** Header status line, from the plan for the horizon. Legacy drafts with no time
 *  are counted on their own instead of inflating "planned". */
export function planStatus(plan: Pick<PlanView, 'counts' | 'review' | 'to'>): string {
  const to = new Date(plan.to).getTime();
  const open = plan.review.filter((r) => !r.approved);
  const inPeriod = open.filter((r) => r.plannedAt && new Date(r.plannedAt).getTime() < to).length;
  const untimed = open.filter((r) => !r.plannedAt).length;
  const waiting = plan.review.filter((r) => r.approved).length;
  const parts = [`${plan.counts.scheduled} scheduled`];
  if (inPeriod) parts.push(`${inPeriod} to review`);
  if (untimed) parts.push(`${untimed} need${untimed === 1 ? 's' : ''} a time`);
  if (waiting) parts.push(`${waiting} waiting on video`);
  if (plan.counts.target) parts.push(`target ${plan.counts.target}`);
  return parts.join(' · ');
}

export const STATUS_LABEL: Record<PostGroup['status'], string> = {
  pending: 'Scheduled',
  publishing: 'Publishing now',
  published: 'Posted',
  failed: 'Failed',
  canceled: 'Canceled',
};

/** Canceled rows the user didn't cancel say why instead. */
const CANCEL_REASON: Record<string, string> = {
  superseded_by_post_now: 'Posted via Post now',
  account_disconnected: 'Account disconnected',
};

export const statusLabel = (g: PostGroup) =>
  (g.status === 'canceled' && g.error && CANCEL_REASON[g.error]) || STATUS_LABEL[g.status];
