import { describe, it, expect } from 'vitest';
import { autoPlace, similarKey, zonedTime } from './autoPlace';
import { MIN_GAP_MS } from './slots';

const IST = 'Asia/Kolkata';
// Sat 17 Oct 2026, 18:00 IST.
const NOW = new Date(Date.UTC(2026, 9, 17, 12, 30));
const ist = (d: Date) => d.toLocaleString('en-GB', { timeZone: IST, weekday: 'short', hour: '2-digit', minute: '2-digit' });
const items = (n: number, kind = 'text') => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, kind }));
const perDay = (m: Map<string, Date>) => {
  const c = new Map<string, number>();
  for (const d of m.values()) { const k = d.toLocaleDateString('en-CA', { timeZone: IST }); c.set(k, (c.get(k) ?? 0) + 1); }
  return c;
};

describe('autoPlace', () => {
  it('lands on local posting times in the user timezone, never in the past', () => {
    const out = autoPlace({ items: items(3), taken: [], from: NOW, days: 7, timeZone: IST });
    // 18:30 today is inside the 1h lead, so today only has 21:00.
    expect([...out.values()].map(ist)).toEqual(['Sat 21:00', 'Sun 09:30', 'Mon 09:30']);
    expect(zonedTime(2026, 9, 18, 9, 30, IST)).toBe(Date.UTC(2026, 9, 18, 4, 0));
    // Either side of the US DST change (1 Nov 2026).
    expect(zonedTime(2026, 9, 30, 9, 30, 'America/New_York')).toBe(Date.UTC(2026, 9, 30, 13, 30));
    expect(zonedTime(2026, 10, 2, 9, 30, 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 14, 30));
  });

  it('spreads evenly and honours the per-day cap; what does not fit stays out', () => {
    const out = autoPlace({ items: items(20), taken: [], from: NOW, days: 7, timeZone: IST, perDay: 2 });
    const c = perDay(out);
    expect(Math.max(...c.values())).toBeLessThanOrEqual(2);
    // Today has one slot left (21:00), the next six days two each.
    expect(out.size).toBe(13);
  });

  it('skips taken slots and counts them toward the cap', () => {
    const taken = [{ at: new Date(Date.UTC(2026, 9, 18, 4, 0)) }, { at: new Date(Date.UTC(2026, 9, 18, 16, 0)) }]; // Sun 09:30, 21:30
    const out = autoPlace({ items: items(3), taken, from: NOW, days: 2, timeZone: IST, perDay: 3 });
    const sun = [...out.values()].filter((d) => ist(d).startsWith('Sun'));
    expect(sun.map(ist)).toEqual(['Sun 12:30']); // 2 taken + 1 = cap
    for (const d of out.values()) for (const t of taken) expect(Math.abs(d.getTime() - t.at.getTime())).toBeGreaterThanOrEqual(MIN_GAP_MS);
  });

  it('keeps near-duplicate takes on different days and mixes kinds', () => {
    const t1 = 'Example: AI video — logo tee, multi-press (take 1)';
    const t2 = 'Example: AI video — logo tee, multi-press (take 2)';
    expect(similarKey(t1)).toBe(similarKey(t2));
    const out = autoPlace({
      items: [{ id: 'a', kind: 'video', group: similarKey(t1) }, { id: 'x', kind: 'text' }, { id: 'b', kind: 'video', group: similarKey(t2) }],
      taken: [], from: new Date(Date.UTC(2026, 9, 17, 20, 0)), days: 2, timeZone: IST, perDay: 3,
    });
    expect(ist(out.get('a')!).slice(0, 3)).not.toBe(ist(out.get('b')!).slice(0, 3));
  });

  it('respects quiet hours as local time', () => {
    const out = autoPlace({ items: items(10), taken: [], from: NOW, days: 7, timeZone: IST, perDay: 5, quiet: { start: '20:00', end: '10:00' } });
    for (const d of out.values()) expect(['12:30', '15:30', '18:30']).toContain(ist(d).slice(4));
  });
});
