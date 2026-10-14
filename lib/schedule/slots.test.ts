import { describe, it, expect } from 'vitest';
import { planSlots, nextFreeSlot, candidateSlots, MIN_GAP_MS } from './slots';

const MON = new Date(Date.UTC(2026, 0, 5, 6, 0)); // Monday 06:00 UTC
const DAY = 24 * 60 * 60 * 1000;
const hourOf = (d: Date) => d.getUTCHours() + d.getUTCMinutes() / 60;
const inBusiness = (d: Date) => [[9, 11], [12, 13], [16, 18]].some(([s, e]) => hourOf(d) >= s && hourOf(d) < e);

describe('planSlots', () => {
  it('spreads a week of posts about one a day, inside business hours, inside the horizon', () => {
    const slots = planSlots({ from: MON, horizonDays: 7, count: 7, taken: [] });
    expect(slots).toHaveLength(7);
    for (const s of slots) {
      expect(inBusiness(s)).toBe(true);
      expect(s.getTime()).toBeGreaterThan(MON.getTime());
      expect(s.getTime()).toBeLessThan(MON.getTime() + 7 * DAY);
    }
    // Spread, not clumped: no day holds more than two.
    const perDay = new Map<number, number>();
    for (const s of slots) perDay.set(s.getUTCDate(), (perDay.get(s.getUTCDate()) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(2);
  });

  it('is sorted, and keeps clear of times already taken', () => {
    const taken = [new Date(Date.UTC(2026, 0, 6, 10, 0)), new Date(Date.UTC(2026, 0, 8, 16, 30))];
    for (let i = 0; i < 50; i++) {
      const slots = planSlots({ from: MON, horizonDays: 7, count: 5, taken });
      expect(slots.map((d) => d.getTime())).toEqual([...slots].map((d) => d.getTime()).sort((a, b) => a - b));
      for (const s of slots) for (const t of taken) expect(Math.abs(s.getTime() - t.getTime())).toBeGreaterThanOrEqual(MIN_GAP_MS);
    }
  });

  it('never returns a time inside quiet hours', () => {
    const quiet = { start: '12:00', end: '09:30' }; // only 09:30-12:00 open
    const slots = planSlots({ from: MON, horizonDays: 30, count: 40, quiet, taken: [] });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(hourOf(s) >= 9.5 && hourOf(s) < 12).toBe(true);
  });

  it('falls back to non-quiet hours when quiet hours cover every business window', () => {
    const quiet = { start: '08:00', end: '19:00' };
    const slots = planSlots({ from: MON, horizonDays: 7, count: 7, quiet, taken: [] });
    expect(slots).toHaveLength(7);
    for (const s of slots) expect(hourOf(s) >= 19 || hourOf(s) < 8).toBe(true);
  });

  it('returns fewer slots than asked when the horizon is full', () => {
    // 3 windows a day; a 2-day horizon from 06:00 cannot hold 20 posts.
    expect(planSlots({ from: MON, horizonDays: 2, count: 20, taken: [] }).length).toBeLessThanOrEqual(6);
  });

  it('a top-up lands in the biggest gap', () => {
    // Everything on Mon/Tue already; one more should go late in the week.
    const taken = candidateSlots(MON, new Date(MON.getTime() + 2 * DAY), null);
    const [s] = planSlots({ from: MON, horizonDays: 7, count: 1, taken });
    expect(s.getTime()).toBeGreaterThan(MON.getTime() + 5 * DAY);
  });
});

describe('nextFreeSlot', () => {
  it('returns the earliest free legal slot', () => {
    const s = nextFreeSlot(MON, null, [], () => 0);
    expect(s.toISOString()).toBe('2026-01-05T09:00:00.000Z');
  });

  it('skips a slot that is taken', () => {
    const s = nextFreeSlot(MON, null, [new Date('2026-01-05T09:30:00Z')], () => 0);
    expect(s.toISOString()).toBe('2026-01-05T12:00:00.000Z');
  });
});
