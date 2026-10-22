import { describe, it, expect } from 'vitest';
import {
  agenda, agendaOrder, asPostText, calendarItems, firstAtRisk, groupRows, idOf, kindOf, overLimit, restorePatch, sameText, soonestToReview, textsOf, textsPatch,
  weekFiled, moveToDay, nextToReview, progress, statusLabel, toneOf,
  type ReviewItem, type ScheduledRow,
} from '../../../../components/calendar/model';
import { postText } from '../../../../lib/agent/postText';
import type { Platform } from '../../../../lib/db/schema';

const row = (o: Partial<ScheduledRow>): ScheduledRow => ({
  id: 'r', draftId: 'd1', accountId: 'a', platform: 'x', scheduledAt: '2026-11-01T09:00:00.000Z', status: 'pending', text: 'hi', ...o,
});
const draft = (o: Partial<ReviewItem>) => ({ id: 'd', title: null, body: 'b', perPlatformText: {}, machine: null, texts: {}, targetPlatforms: ['x'], media: [], plannedAt: null, overdue: false, rendering: false, approved: false, tooLong: [], score: null, rationale: null, source: 'agent', createdAt: '', ...o }) as ReviewItem;
const at = (day: number, h = 9) => new Date(2026, 10, day, h).toISOString();

describe('calendar groupRows', () => {
  it('folds a draft\'s per-platform rows at the same time and status into one post', () => {
    const g = groupRows([row({ id: '1' }), row({ id: '2', platform: 'linkedin' })]);
    expect(g).toHaveLength(1);
    expect(g[0].platforms).toEqual(['x', 'linkedin']);
    expect(g[0].rows.map((r) => r.id)).toEqual(['1', '2']);
  });

  it('keeps a failed platform apart from its published sibling', () => {
    const g = groupRows([row({ id: '1', status: 'published' }), row({ id: '2', platform: 'linkedin', status: 'failed' })]);
    expect(g.map((x) => x.status).sort()).toEqual(['failed', 'published']);
  });

  it('flags a pending post whose account is gone', () => {
    const [g] = groupRows([row({ accountId: null })]);
    expect(g.accountGone).toBe(true);
    const [item] = calendarItems([], [g]);
    expect(toneOf(item)).toBe('failed');
    expect(statusLabel(item)).toBe('Reconnect account');
  });

  it('sorts by time', () => {
    const g = groupRows([row({ draftId: 'b', scheduledAt: '2026-11-02T09:00:00.000Z' }), row({ draftId: 'a' })]);
    expect(g.map((x) => x.rows[0].draftId)).toEqual(['a', 'b']);
  });
});

describe('home model', () => {
  const today = new Date(2026, 10, 1);

  it('lists untimed drafts first, then drafts and posts in time order', () => {
    const items = calendarItems(
      [draft({ id: 'a', plannedAt: '2026-11-01T10:00:00.000Z' }), draft({ id: 'b' })],
      groupRows([row({ scheduledAt: '2026-11-01T08:00:00.000Z' })]),
    );
    expect(items.map(idOf)).toEqual(['b', 'd1', 'a']);
    expect(toneOf(items[2])).toBe('review');
  });

  it('tells video, image and text apart, a rendering video included', () => {
    const [v, i, t, r] = calendarItems([
      draft({ id: 'v', plannedAt: at(1, 1), media: [{ id: 'm', url: 'u', mimeType: 'video/mp4' }] }),
      draft({ id: 'i', plannedAt: at(1, 2), media: [{ id: 'm', url: 'u', mimeType: 'image/png' }] }),
      draft({ id: 't', plannedAt: at(1, 3) }),
      draft({ id: 'r', plannedAt: at(1, 4), rendering: true }),
    ], []);
    expect([v, i, t, r].map(kindOf)).toEqual(['video', 'image', 'text', 'video']);
  });

  it('agenda: needs-a-time (untimed, a past day, or passed today), the 7 days kept even when empty, then later', () => {
    const now = new Date(2026, 10, 1, 12).getTime();
    const items = calendarItems([
      draft({ id: 'u' }),
      draft({ id: 'past', plannedAt: at(0 /* Oct 31 */) }),
      draft({ id: 'passedToday', plannedAt: at(1, 9) }),
      draft({ id: 'a', plannedAt: at(1, 15), title: 'Launch day' }),
      draft({ id: 'rend', plannedAt: at(1, 8), approved: true, rendering: true }),
      draft({ id: 'far', plannedAt: at(9) }),
    ], groupRows([row({ draftId: 'p', scheduledAt: at(3) })]));
    const ag = agenda(items, today, now);
    expect(ag.need.map(idOf)).toEqual(['u', 'past', 'passedToday']);
    // An approved-while-rendering draft isn't waiting on the user, so it stays on its day.
    expect(ag.days[0].items.map(idOf)).toEqual(['rend', 'a']);
    expect(ag.days[2].items.map(idOf)).toEqual(['p']);
    expect(ag.later.map(idOf)).toEqual(['far']);
    expect(ag.days).toHaveLength(7);
    expect(agenda([], today, now).days.every((d) => d.items.length === 0)).toBe(true);
    expect(agendaOrder(ag).map(idOf)).toEqual(['u', 'past', 'passedToday', 'rend', 'a', 'p', 'far']);
  });

  it('opens on the soonest timed post to review, not the needs-a-time pile', () => {
    const now = new Date(2026, 10, 1, 12).getTime();
    const items = calendarItems([
      draft({ id: 'u' }),
      draft({ id: 'ok', plannedAt: at(1, 13), approved: true, rendering: true }),
      draft({ id: 'b', plannedAt: at(2, 9) }),
      draft({ id: 'a', plannedAt: at(1, 18) }),
    ], []);
    expect(idOf(soonestToReview(agenda(items, today, now))!)).toBe('a');
    expect(idOf(soonestToReview(agenda(calendarItems([draft({ id: 'u' })], []), today, now))!)).toBe('u');
    expect(soonestToReview(agenda([], today, now))).toBeNull();
  });

  it('counts progress over everything but canceled posts', () => {
    const items = calendarItems(
      [draft({ id: 'a' }), draft({ id: 'b', approved: true })],
      groupRows([row({ draftId: 'p' }), row({ draftId: 'c', status: 'canceled', scheduledAt: at(2) })]),
    );
    expect(progress(items)).toEqual({ done: 2, total: 3 });
  });

  it('next to review: rest of the day, then later days, wrapping round; never the current one', () => {
    const order = calendarItems([
      draft({ id: 'a', plannedAt: at(1, 9) }),
      draft({ id: 'b', plannedAt: at(1, 12) }),
      draft({ id: 'c', plannedAt: at(2, 9) }),
    ], groupRows([row({ draftId: 's', scheduledAt: at(1, 10) })]));
    expect(nextToReview(order, 'a') && idOf(nextToReview(order, 'a')!)).toBe('b');
    expect(idOf(nextToReview(order, 'b')!)).toBe('c');
    expect(idOf(nextToReview(order, 'c')!)).toBe('a');
    expect(idOf(nextToReview(order, 's')!)).toBe('b');
    expect(nextToReview(order.filter((i) => idOf(i) !== 'b' && idOf(i) !== 'c'), 'a')).toBeNull();
  });

  it('moves to another day keeping the time of day; untimed lands at 10 AM', () => {
    const day = new Date(2026, 10, 5);
    const [post] = calendarItems([], groupRows([row({ scheduledAt: new Date(2026, 10, 1, 14, 30).toISOString() })]));
    expect(moveToDay(post, day)).toEqual(new Date(2026, 10, 5, 14, 30));
    expect(moveToDay({ kind: 'draft', key: 'x', at: null, draft: draft({}) }, day)).toEqual(new Date(2026, 10, 5, 10, 0));
  });

  it('the week is filed only when nothing waits on review and nothing failed', () => {
    expect(weekFiled([])).toBe(false);
    expect(weekFiled(calendarItems([], groupRows([row({})])))).toBe(true);
    expect(weekFiled(calendarItems([draft({ id: 'a' })], groupRows([row({})])))).toBe(false);
    expect(weekFiled(calendarItems([], groupRows([row({ status: 'failed' })])))).toBe(false);
  });

  it('per-platform text: what each tab shows is postText, the publisher’s rule', () => {
    const machine = { text: 'orig body', perPlatform: { linkedin: 'li machine', facebook: 'fb machine' } };
    const d = draft({ body: 'orig body', perPlatformText: { linkedin: 'li machine', facebook: 'fb machine' }, machine, targetPlatforms: ['linkedin', 'facebook'] });
    const [it] = calendarItems([d], []);
    expect(textsOf(it)).toEqual({ linkedin: 'li machine', facebook: 'fb machine' });
    // The body was edited elsewhere (Compose): stale machine copy gives way to the body.
    const [edited] = calendarItems([{ ...d, body: 'new body' }], []);
    expect(textsOf(edited)).toEqual({ linkedin: 'new body', facebook: 'new body' });
    const [p] = calendarItems([], groupRows([row({ text: 'on x' }), row({ id: '2', platform: 'linkedin', text: 'on li' })]));
    expect(textsOf(p)).toEqual({ x: 'on x', linkedin: 'on li' });
  });

  const PL: Platform[] = ['linkedin', 'facebook'];
  const machine = { text: 'orig body', perPlatform: { linkedin: 'li machine', facebook: 'fb machine', youtube: 'yt machine' } };
  const base = draft({ body: 'orig body', perPlatformText: { ...machine.perPlatform }, machine, targetPlatforms: PL });
  const posts = (d: ReviewItem, patch: object) => Object.fromEntries(PL.map((p) => [p, postText({ ...asPostText(d), ...patch }, p)]));

  it('saving typed texts: every platform posts exactly what was typed, body edited or not', () => {
    const typed = { linkedin: 'my li', facebook: 'fb machine' };
    expect(posts(base, textsPatch(base, typed, PL, false))).toEqual(typed);
    const bodyEdited = { ...base, body: 'edited body' };
    expect(posts(bodyEdited, textsPatch(bodyEdited, { linkedin: 'my li', facebook: 'my fb' }, PL, false))).toEqual({ linkedin: 'my li', facebook: 'my fb' });
    // A hand-made draft (no snapshot) too.
    const hand = draft({ body: 'b', targetPlatforms: PL });
    expect(posts(hand, textsPatch(hand, { linkedin: 'one', facebook: 'two' }, PL, false))).toEqual({ linkedin: 'one', facebook: 'two' });
  });

  it('saving keeps per-platform copy for platforms the draft doesn\'t target', () => {
    expect(textsPatch(base, { linkedin: 'x', facebook: 'y' }, PL, false).perPlatformText.youtube).toBe('yt machine');
  });

  it('same text everywhere: the body, posted on every platform', () => {
    const patch = textsPatch(base, { linkedin: 'shared', facebook: 'shared' }, PL, true);
    expect(patch).toEqual({ body: 'shared', perPlatformText: {} });
    expect(posts(base, patch)).toEqual({ linkedin: 'shared', facebook: 'shared' });
  });

  it('edge: retyping Autopilot\'s exact copy after the body was edited posts the body (postText), and the tab then shows that', () => {
    const bodyEdited = { ...base, body: 'edited body' };
    const patch = textsPatch(bodyEdited, { linkedin: 'li machine', facebook: 'mine' }, PL, false);
    expect(posts(bodyEdited, patch)).toEqual({ linkedin: 'edited body', facebook: 'mine' });
    const [after] = calendarItems([{ ...bodyEdited, ...patch }], []);
    expect(textsOf(after).linkedin).toBe('edited body');
  });

  it('restoring Autopilot\'s versions posts the machine copy again', () => {
    const same = { ...base, ...textsPatch(base, { linkedin: 'shared', facebook: 'shared' }, PL, true) };
    const r = restorePatch(same)!;
    expect(posts(same, r)).toEqual({ linkedin: 'li machine', facebook: 'fb machine' });
    expect(restorePatch(draft({}))).toBeNull();
  });

  it('same-text and over-limit checks', () => {
    expect(sameText({ linkedin: 'a', facebook: 'a' }, PL)).toBe(true);
    expect(sameText({ linkedin: 'a', facebook: 'b' }, PL)).toBe(false);
    expect(sameText({ linkedin: 'a' }, ['linkedin'])).toBe(true);
    expect(overLimit({ x: 'x'.repeat(281), linkedin: 'ok' }, ['x', 'linkedin'], { x: 280, linkedin: 3000 })).toEqual(['x']);
  });

  it('names the first upcoming post on a disconnected platform', () => {
    const items = calendarItems([draft({ id: 'a', plannedAt: at(2), targetPlatforms: ['linkedin'] }), draft({ id: 'b', plannedAt: at(3) })], []);
    expect(idOf(firstAtRisk(items, ['x'], today.getTime())!)).toBe('b');
    expect(firstAtRisk(items, ['instagram'], today.getTime())).toBeNull();
  });
});
