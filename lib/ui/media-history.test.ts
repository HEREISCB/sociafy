import { describe, expect, it } from 'vitest';
import { groupByDay, mediaTime } from './media-history';

const at = (d: Date) => ({ createdAt: d.getTime() });

/** Local 01:00 today — the case that files under UTC-yesterday if you compare
 *  ISO dates instead of local calendar days. */
function todayAt(h: number, m = 0): Date {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

describe('groupByDay', () => {
  it('buckets by local calendar day, newest day first', () => {
    const yesterday = new Date(todayAt(9).getTime() - 86_400_000);
    const older = new Date(todayAt(9).getTime() - 9 * 86_400_000);
    const groups = groupByDay([at(older), at(yesterday), at(todayAt(14, 32)), at(todayAt(1, 5))]);
    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY', expect.stringMatching(/^[A-Z]{3} \d+$/)]);
    expect(groups[0].entries).toHaveLength(2); // 14:32 and 01:05 are the same local day
  });

  it('keeps the source index so hero selection still points at the right item', () => {
    const items = [at(todayAt(9)), at(new Date(todayAt(9).getTime() - 86_400_000)), at(todayAt(18))];
    const groups = groupByDay(items);
    expect(groups[0].entries.map((e) => e.index)).toEqual([2, 0]); // newest first within the day
    expect(groups[1].entries.map((e) => e.index)).toEqual([1]);
  });

  it('does not file undated items under today', () => {
    const groups = groupByDay([{ createdAt: undefined }, at(todayAt(10))]);
    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'UNDATED']);
    expect(groups[0].entries).toHaveLength(1);
  });

  it('returns nothing for an empty list (no empty groups)', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('mediaTime', () => {
  it('shows a bare clock for the same local day', () => {
    expect(mediaTime(todayAt(14, 32).getTime())).toBe('14:32');
    expect(mediaTime(todayAt(1, 5).getTime())).toBe('01:05');
  });

  it('prefixes the date on any other day', () => {
    const out = mediaTime(new Date(todayAt(14, 32).getTime() - 3 * 86_400_000).getTime());
    expect(out).toMatch(/^\w+ \d+ · 14:32$/);
  });

  it('formats an unknown timestamp as empty rather than inventing one', () => {
    expect(mediaTime(undefined)).toBe('');
  });
});
