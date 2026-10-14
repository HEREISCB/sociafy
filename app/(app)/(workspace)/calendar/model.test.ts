import { describe, it, expect } from 'vitest';
import { groupRows, needsAttention, type ScheduledRow } from '../../../../components/calendar/model';

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
