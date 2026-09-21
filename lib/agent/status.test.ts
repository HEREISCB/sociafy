import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: () => ({}) }));
vi.mock('../credits/ledger', () => ({ getBalance: async () => 0 }));

import { nextDraftDue, nextTick, kindQueue, affordableKind } from './status';
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

describe('kindQueue', () => {
  const none = { text: 0, image: 0, video: 0 };
  it('leads with the kind furthest behind its weekly share', () => {
    expect(kindQueue({ text: 4, image: 2, video: 0 }, { text: 2, image: 0, video: 0 }, ['x'])).toEqual(['image', 'text']);
  });
  it('never offers a kind no enabled platform can publish', () => {
    expect(kindQueue({ text: 4, image: 1, video: 1 }, none, ['instagram'])).toEqual(['image', 'video']);
    expect(kindQueue({ text: 4, image: 1, video: 0 }, none, ['tiktok'])).toEqual([]);
  });
  it('falls back to text once the mix is met', () => {
    expect(kindQueue({ text: 1, image: 1, video: 0 }, { text: 1, image: 1, video: 0 }, ['x'])).toEqual(['text']);
  });
});

describe('affordableKind', () => {
  it('drops to a cheaper kind rather than crossing the weekly cap', () => {
    // video is 149, text is 4
    expect(affordableKind(['video', 'text'], 1000, 100, 0)).toEqual({ kind: 'text' });
    expect(affordableKind(['video', 'text'], 1000, null, 0)).toEqual({ kind: 'video' });
  });
  it('blocks the draft that would cross the cap, not the one that reaches it', () => {
    expect(affordableKind(['text'], 1000, 8, 4)).toEqual({ kind: 'text' });
    expect(affordableKind(['text'], 1000, 8, 8)).toEqual({ blocked: 'credit_cap' });
  });
  it('says out of credits before it says capped', () => {
    expect(affordableKind(['text'], 3, 0, 0)).toEqual({ blocked: 'no_credits' });
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
