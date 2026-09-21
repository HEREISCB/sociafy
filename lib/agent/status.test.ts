import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: () => ({}) }));
vi.mock('../credits/ledger', () => ({ getBalance: async () => 0 }));

import { nextDraftDue, nextTick, overCap } from './status';
import { recommendPlan } from './recommend';

const H = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);

describe('nextDraftDue', () => {
  it('is due immediately when nothing has been drafted', () => {
    expect(nextDraftDue(4, [])!.getTime()).toBeLessThan(Date.now());
  });
  it('spaces drafts evenly across the week', () => {
    const last = at('2026-09-21T10:00:00Z');
    expect(nextDraftDue(4, [last])).toEqual(new Date(last.getTime() + 42 * H));
  });
  it('waits for the oldest draft to age out once the weekly budget is spent', () => {
    const times = [at('2026-09-15T00:00:00Z'), at('2026-09-15T01:00:00Z')];
    expect(nextDraftDue(2, times)).toEqual(at('2026-09-22T00:00:00Z'));
  });
  it('never drafts at cadence 0', () => {
    expect(nextDraftDue(0, [])).toBeNull();
  });
});

describe('nextTick', () => {
  it('rounds up to the next even UTC hour', () => {
    expect(nextTick(at('2026-09-21T10:01:00Z'))).toEqual(at('2026-09-21T12:00:00Z'));
    expect(nextTick(at('2026-09-21T11:00:00Z'))).toEqual(at('2026-09-21T12:00:00Z'));
    expect(nextTick(at('2026-09-21T23:30:00Z'))).toEqual(at('2026-09-22T00:00:00Z'));
  });
  it('keeps a time already on a tick', () => {
    expect(nextTick(at('2026-09-21T10:00:00Z'))).toEqual(at('2026-09-21T10:00:00Z'));
  });
});

describe('overCap', () => {
  it('blocks the draft that would cross the cap, not the one that reaches it', () => {
    expect(overCap(8, 4)).toBe(false);
    expect(overCap(8, 8)).toBe(true);
    expect(overCap(null, 9999)).toBe(false);
  });
});

describe('recommendPlan', () => {
  it('pushes B2B niches toward LinkedIn and feeds the busiest platform', () => {
    const plan = recommendPlan(['linkedin', 'instagram'], ['saas']);
    expect(plan.perPlatform).toEqual({ linkedin: 5, instagram: 4 });
    expect(plan.cadencePerWeek).toBe(5);
  });
  it('recommends nothing for no platforms', () => {
    expect(recommendPlan([], ['saas']).cadencePerWeek).toBe(0);
  });
});
