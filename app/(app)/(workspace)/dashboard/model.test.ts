import { describe, it, expect } from 'vitest';
import {
  buckets, calendarItems, groupRows, idOf, kindOf, moveToDay, nextToReview, progress, statusLabel, toneOf, LATER, NO_TIME,
  type ReviewItem, type ScheduledRow,
} from '../../../../components/calendar/model';

const row = (o: Partial<ScheduledRow>): ScheduledRow => ({
  id: 'r', draftId: 'd1', accountId: 'a', platform: 'x', scheduledAt: '2026-11-01T09:00:00.000Z', status: 'pending', text: 'hi', ...o,
});
const draft = (o: Partial<ReviewItem>) => ({ id: 'd', title: null, body: 'b', perPlatformText: {}, targetPlatforms: ['x'], media: [], plannedAt: null, overdue: false, rendering: false, approved: false, tooLong: [], score: null, rationale: null, source: 'agent', createdAt: '', ...o }) as ReviewItem;
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

  it('buckets the week: needs-a-time (untimed or a past day), 7 days, later; with topic and review counts', () => {
    const items = calendarItems([
      draft({ id: 'u' }),
      draft({ id: 'past', plannedAt: at(0 /* Oct 31 */) }),
      draft({ id: 'a', plannedAt: at(1), title: 'Launch day' }),
      draft({ id: 'b', plannedAt: at(1, 15), approved: true }),
      draft({ id: 'far', plannedAt: at(9) }),
    ], groupRows([row({ draftId: 'p', scheduledAt: at(3) })]));
    const bs = buckets(items, today);
    expect(bs.map((b) => b.key)).toEqual([NO_TIME, '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', LATER]);
    expect(bs[0].items.map(idOf)).toEqual(['u', 'past']);
    expect(bs[1]).toMatchObject({ topic: 'Launch day', toReview: 1 });
    expect(bs[1].items).toHaveLength(2);
    expect(bs[3]).toMatchObject({ topic: null, toReview: 0 });
    expect(bs[8].items.map(idOf)).toEqual(['far']);
    // Empty edge buckets drop out; the 7 days always stay.
    expect(buckets([], today)).toHaveLength(7);
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
});
