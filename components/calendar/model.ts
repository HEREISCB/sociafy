import { addDays, differenceInCalendarDays, format } from 'date-fns';
import { PLATFORM_LABELS } from '../../lib/ui/platforms';
import type { DraftMedia, Platform } from '../../lib/db/schema';
import type { PlanView } from '../../lib/agent/plan';
import { postText, type PostTextDraft } from '../../lib/agent/postText';

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

/** Still to review and without a usable time: never set, or already passed. The same set
 *  "Spread across the week" places (lib/agent/plan.ts spreadDrafts: planned_at null or < now). */
export const needsTime = (i: CalItem, now: number) => toReview(i) && (!i.at || i.at.getTime() < now);

/** The agenda: "Needs a time" first, then the 7 days from today (kept even when empty), then Later. */
export type Agenda = { need: CalItem[]; days: { day: Date; items: CalItem[] }[]; later: CalItem[] };
export function agenda(items: CalItem[], today: Date, now: number): Agenda {
  const out: Agenda = { need: [], days: Array.from({ length: 7 }, (_, n) => ({ day: addDays(today, n), items: [] })), later: [] };
  for (const i of items) {
    if (needsTime(i, now)) { out.need.push(i); continue; }
    // Not the user's to place (approved, or a queued post): anything before today sits on today.
    const k = i.at ? Math.max(0, differenceInCalendarDays(i.at, today)) : 0;
    if (k >= 7) out.later.push(i); else out.days[k].items.push(i);
  }
  return out;
}
export const agendaOrder = (a: Agenda) => [...a.need, ...a.days.flatMap((d) => d.items), ...a.later];

/** Where Home opens: the soonest timed post still to review (it goes out first), else the first one to review. */
export function soonestToReview(a: Agenda): CalItem | null {
  return [...a.days.flatMap((d) => d.items), ...a.later].find(toReview) ?? a.need[0] ?? agendaOrder(a)[0] ?? null;
}

/** Header meter: everything on Home except canceled posts; reviewed = no longer waiting on the user. */
export function progress(items: CalItem[]) {
  const total = items.filter((i) => toneOf(i) !== 'canceled').length;
  return { done: total - items.filter(toReview).length, total };
}

/** After an approve or skip: the next post to review after `fromId` in agenda order —
 *  the rest of that day, then the following days, wrapping round. */
export function nextToReview(order: CalItem[], fromId: string): CalItem | null {
  const at = order.findIndex((i) => idOf(i) === fromId);
  for (let k = 1; k <= order.length; k++) {
    const c = order[(at + k) % order.length];
    if (toReview(c) && idOf(c) !== fromId) return c;
  }
  return null;
}

/** Nothing left that needs the user: no draft to review and no failed post. */
export const weekFiled = (items: CalItem[]) => items.length > 0 && !items.some((i) => toReview(i) || toneOf(i) === 'failed');

/** The draft as postText reads it. `machine` is Autopilot's variant-A snapshot (GET /api/plan). */
export const asPostText = (d: Pick<ReviewItem, 'body' | 'perPlatformText' | 'machine'>): PostTextDraft =>
  ({ body: d.body, perPlatformText: d.perPlatformText, variants: d.machine ? [d.machine] : null });

/** What each platform posts: for a draft, postText on every target (the publisher's own rule); for a queued post, its rows. */
export function textsOf(i: CalItem): Partial<Record<Platform, string>> {
  if (i.kind === 'post') return Object.fromEntries(i.group.rows.map((r) => [r.platform, r.text]));
  const d = asPostText(i.draft);
  return Object.fromEntries((i.draft.targetPlatforms ?? []).map((p) => [p, postText(d, p)]));
}

export const sameText = (texts: Partial<Record<Platform, string>>, platforms: Platform[]) =>
  new Set(platforms.map((p) => texts[p] ?? '')).size <= 1;

export const overLimit = (texts: Partial<Record<Platform, string>>, platforms: Platform[], limits: Partial<Record<Platform, number>>) =>
  platforms.filter((p) => (texts[p] ?? '').length > (limits[p] ?? Infinity));

export type TextsPatch = { body?: string; perPlatformText: Partial<Record<Platform, string>> };

/**
 * PATCH /api/drafts/:id body that makes each platform post what was typed.
 * Same text: the body, and no per-platform copy, so postText falls back to the body everywhere.
 * Otherwise an explicit entry per target (non-target entries are kept). One case postText
 * overrides: a platform's text retyped to Autopilot's exact copy after the body was edited
 * posts the body (the refetch shows that).
 */
export function textsPatch(d: Pick<ReviewItem, 'perPlatformText'>, typed: Partial<Record<Platform, string>>, platforms: Platform[], same: boolean): TextsPatch {
  if (same) return { body: typed[platforms[0]] ?? '', perPlatformText: {} };
  return { perPlatformText: { ...d.perPlatformText, ...Object.fromEntries(platforms.map((p) => [p, typed[p] ?? ''])) } };
}

/** Autopilot's original per-platform versions (variant A), or null for a hand-made draft. */
export const restorePatch = (d: Pick<ReviewItem, 'machine'>): Required<TextsPatch> | null =>
  d.machine ? { body: d.machine.text, perPlatformText: { ...d.machine.perPlatform } } : null;

/** The first post still to go out on one of these platforms (for "X needs reconnecting before …"). */
export const firstAtRisk = (items: CalItem[], platforms: Platform[], now: number): CalItem | null =>
  items.find((i) => i.at && i.at.getTime() > now && toneOf(i) !== 'canceled' && toneOf(i) !== 'published' && itemPlatforms(i).some((p) => platforms.includes(p))) ?? null;

export type Skipped = { reason: string; reasons?: Record<string, string>; platforms?: Platform[] };

export function skipMessage(s: Skipped): string {
  if (s.reason === 'too_long') return `Too long for ${(s.platforms ?? []).map((p) => PLATFORM_LABELS[p] ?? p).join(', ')}.`;
  if (s.reason === 'not_a_draft') return 'Already scheduled.';
  if (s.reason === 'not_found') return 'This post is gone.';
  const gone = Object.entries(s.reasons ?? {}).filter(([, r]) => r === 'disconnected').map(([p]) => PLATFORM_LABELS[p] ?? p);
  if (gone.length) return `Reconnect ${gone.join(', ')} first.`;
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
