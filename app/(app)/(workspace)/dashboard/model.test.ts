import { describe, it, expect } from 'vitest';
import { calendarItems, groupRows, moveToDay, needsAttention, planStatus, toneOf, type ReviewItem, type ScheduledRow } from '../../../../components/calendar/model';

const row = (o: Partial<ScheduledRow>): ScheduledRow => ({
  id: 'r', draftId: 'd1', accountId: 'a', platform: 'x', scheduledAt: '2026-11-01T09:00:00.000Z', status: 'pending', text: 'hi', ...o,
});

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

  it('flags a pending post whose account is gone as needing attention', () => {
    const [g] = groupRows([row({ accountId: null })]);
    expect(g.accountGone).toBe(true);
    expect(needsAttention(g)).toBe(true);
    expect(needsAttention(groupRows([row({})])[0])).toBe(false);
  });

  it('sorts by time', () => {
    const g = groupRows([row({ draftId: 'b', scheduledAt: '2026-11-02T09:00:00.000Z' }), row({ draftId: 'a' })]);
    expect(g.map((x) => x.rows[0].draftId)).toEqual(['a', 'b']);
  });
});

describe('home calendar model', () => {
  const draft = (o: Partial<ReviewItem>) => ({ id: 'd', title: null, body: 'b', perPlatformText: {}, targetPlatforms: ['x'], media: [], plannedAt: null, overdue: false, rendering: false, approved: false, tooLong: [], score: null, source: 'agent', createdAt: '', ...o }) as ReviewItem;

  it('puts dated drafts and posts on the calendar in time order, undated drafts nowhere', () => {
    const items = calendarItems(
      [draft({ id: 'a', plannedAt: '2026-11-01T10:00:00.000Z' }), draft({ id: 'b' })],
      groupRows([row({ scheduledAt: '2026-11-01T08:00:00.000Z' })]),
    );
    expect(items.map((i) => i.kind)).toEqual(['post', 'draft']);
    expect(toneOf(items[1])).toBe('review');
  });

  it('leads with everything to review, untimed ones called out', () => {
    const s = planStatus({
      counts: { scheduled: 2, target: 5 } as never,
      review: [draft({ id: 'a', plannedAt: '2026-11-02T10:00:00.000Z' }), draft({ id: 'b' }), draft({ id: 'c' })],
    });
    expect(s).toBe('3 to review (2 need a time) · 2 scheduled · target 5');
  });

  it('moves to another day keeping the time of day; untimed lands at 10 AM', () => {
    const day = new Date(2026, 10, 5);
    const [post] = calendarItems([], groupRows([row({ scheduledAt: new Date(2026, 10, 1, 14, 30).toISOString() })]));
    expect(moveToDay(post, day)).toEqual(new Date(2026, 10, 5, 14, 30));
    expect(moveToDay({ kind: 'draft', key: 'x', at: null, draft: draft({}) }, day)).toEqual(new Date(2026, 10, 5, 10, 0));
  });
});
