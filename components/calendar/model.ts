import { addDays, format } from 'date-fns';
import { PLATFORM_LABELS } from '../../lib/ui/platforms';
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

/** Anything Home shows on the calendar or in the buffer (spinner) card. */
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

/** Only a post the user canceled may be restored: one Post now already sent,
 *  or one canceled by an account disconnect, would publish twice (the API 409s). */
export const restorable = (g: PostGroup) => g.status === 'canceled' && g.error === 'user_canceled';

/** Every draft and scheduled post: timed ones in time order, untimed drafts first. */
export function calendarItems(review: ReviewItem[], groups: PostGroup[]): CalItem[] {
  return [
    ...review.map((d): CalItem => ({ kind: 'draft', key: `d${d.id}`, at: d.plannedAt ? new Date(d.plannedAt) : null, draft: d })),
    ...groups.map((g): CalItem => ({ kind: 'post', key: g.key, at: g.at, group: g })),
  ].sort((a, b) => (a.at?.getTime() ?? -Infinity) - (b.at?.getTime() ?? -Infinity));
}

export const dayKey = (d: Date) => format(d, 'yyyy-MM-dd');

/** Visual status: drives the card's styling and badge. */
export type Tone = 'review' | 'waiting' | 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';
export function toneOf(i: CalItem): Tone {
  if (i.kind === 'draft') return i.draft.approved ? 'waiting' : 'review';
  return i.group.accountGone ? 'failed' : i.group.status;
}

export const itemMedia = (i: CalItem): DraftMedia | undefined => (i.kind === 'draft' ? i.draft.media[0] : i.group.media[0]);
export const itemPlatforms = (i: CalItem): Platform[] => (i.kind === 'draft' ? i.draft.targetPlatforms ?? [] : i.group.platforms);
export const itemText = (i: CalItem) => (i.kind === 'draft' ? i.draft.body : i.group.text);
export const isVideo = (m?: DraftMedia) => !!m?.mimeType?.startsWith('video/');

/** A post's draft id: stable across a move or an approve (a group's key includes its time and status). */
export const idOf = (i: CalItem) => (i.kind === 'draft' ? i.draft.id : i.group.rows[0].draftId);

export type Kind = 'video' | 'image' | 'text';
export function kindOf(i: CalItem): Kind {
  const m = itemMedia(i);
  if (isVideo(m) || (i.kind === 'draft' && i.draft.rendering && !m)) return 'video';
  return m ? 'image' : 'text';
}
export const KIND_LABEL: Record<Kind, string> = { video: 'Video', image: 'Image', text: 'Text' };

/** Still waiting on the user. An approved-while-rendering draft is not. */
export const toReview = (i: CalItem) => i.kind === 'draft' && !i.draft.approved;

/** What can move to another day or time: unapproved drafts and still-pending posts. */
export const movable = (i: CalItem) =>
  i.kind === 'draft' ? !i.draft.approved : i.group.status === 'pending' && !i.group.accountGone;

/** Same time of day on another date; a draft without a time lands at 10 AM. */
export function moveToDay(i: CalItem, day: Date): Date {
  const d = new Date(day);
  if (i.at) d.setHours(i.at.getHours(), i.at.getMinutes(), 0, 0);
  else d.setHours(10, 0, 0, 0);
  return d;
}

/** The strip: the buffer/spinner card (no time, or one on a day already gone), the 7 days from
 *  today, then "Later" (beyond the week). Empty edge buckets are dropped. */
export type Bucket = {
  key: string;
  /** null for the buffer and "Later" buckets. */
  day: Date | null;
  items: CalItem[];
  /** The day's topic: its first titled draft. */
  topic: string | null;
  toReview: number;
};
export const NO_TIME = 'none';
export const LATER = 'later';

export function buckets(items: CalItem[], today: Date): Bucket[] {
  const end = addDays(today, 7);
  const keyOf = (i: CalItem) => (!i.at || i.at < today ? NO_TIME : i.at >= end ? LATER : dayKey(i.at));
  const days = Array.from({ length: 7 }, (_, n) => addDays(today, n));
  const out: Bucket[] = [NO_TIME, ...days, LATER].map((d) => {
    const key = typeof d === 'string' ? d : dayKey(d);
    const its = items.filter((i) => keyOf(i) === key);
    const titled = its.find((i) => i.kind === 'draft' && i.draft.title?.trim());
    return {
      key,
      day: typeof d === 'string' ? null : d,
      items: its,
      topic: titled?.kind === 'draft' ? titled.draft.title!.trim() : null,
      toReview: its.filter(toReview).length,
    };
  });
  return out.filter((b) => b.day || b.items.length);
}

/** Header meter: everything on Home except canceled posts; reviewed = no longer waiting on the user. */
export function progress(items: CalItem[]) {
  const total = items.filter((i) => toneOf(i) !== 'canceled').length;
  return { done: total - items.filter(toReview).length, total };
}

/** After an approve or skip: the next post to review after `fromId` in strip order —
 *  the rest of that day, then the following days, wrapping round. */
export function nextToReview(order: CalItem[], fromId: string): CalItem | null {
  const at = order.findIndex((i) => idOf(i) === fromId);
  for (let k = 1; k <= order.length; k++) {
    const c = order[(at + k) % order.length];
    if (toReview(c) && idOf(c) !== fromId) return c;
  }
  return null;
}

/** Where a day tile's click lands: its first post to review, else its first post. */
export const firstOfDay = (b: Bucket): CalItem | null => b.items.find(toReview) ?? b.items[0] ?? null;

/** Nothing left that needs the user: no draft to review and no failed post. */
export const weekFiled = (items: CalItem[]) => items.length > 0 && !items.some((i) => toReview(i) || toneOf(i) === 'failed');

/** The platform whose limit the caption hits first: the counter measures against it. */
export function tightestLimit(platforms: Platform[], limits: Record<Platform, number>): { platform: Platform; limit: number } | null {
  return platforms.reduce<{ platform: Platform; limit: number } | null>(
    (best, p) => (limits[p] && (!best || limits[p] < best.limit) ? { platform: p, limit: limits[p] } : best), null);
}

/** What goes out on `p`. A draft edited here posts the edited body everywhere (publish.ts postText). */
export function textFor(i: CalItem, p: Platform, body: string): string {
  if (i.kind === 'post') return i.group.rows.find((r) => r.platform === p)?.text ?? i.group.text;
  return body !== i.draft.body ? body : i.draft.texts?.[p] ?? body;
}

/** The first post still to go out on one of these platforms (for "X needs reconnecting before …"). */
export const firstAtRisk = (items: CalItem[], platforms: Platform[], now: number): CalItem | null =>
  items.find((i) => i.at && i.at.getTime() > now && toneOf(i) !== 'canceled' && toneOf(i) !== 'published' && itemPlatforms(i).some((p) => platforms.includes(p))) ?? null;

export type Skipped = { reason: string; reasons?: Record<string, string>; platforms?: Platform[] };

export function skipMessage(s: Skipped): string {
  if (s.reason === 'too_long') return `Too long for ${(s.platforms ?? []).map((p) => PLATFORM_LABELS[p] ?? p).join(', ')}.`;
  if (s.reason === 'not_a_draft') return 'Already scheduled.';
  if (s.reason === 'not_found') return 'This post is gone.';
  return Object.values(s.reasons ?? {})[0] ?? 'Could not schedule this post.';
}

/** "Thu 16 Oct · 12:39 AM" */
export const fmtSlot = (d: Date) => format(d, 'EEE d MMM · h:mm a');

const STATUS_LABEL: Record<Tone, string> = {
  review: 'Needs review',
  waiting: 'Approved',
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

export function statusLabel(i: CalItem): string {
  if (i.kind === 'post' && i.group.accountGone) return 'Reconnect account';
  if (i.kind === 'post' && i.group.status === 'canceled' && i.group.error) return CANCEL_REASON[i.group.error] ?? STATUS_LABEL.canceled;
  return STATUS_LABEL[toneOf(i)];
}
