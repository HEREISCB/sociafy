import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: () => ({}) }));
vi.mock('../credits/ledger', () => ({ getBalance: async () => 0 }));

import { planGap, nextTick, kindQueue, affordableKind } from './status';
import { recommendPlan, mixFor, presetOf, platformCaps } from './recommend';

const at = (iso: string) => new Date(iso);

describe('planGap', () => {
  const now = at('2026-09-21T10:01:00Z');
  it('scales the weekly target to the horizon', () => {
    expect(planGap(7, 30, 0, now, true).target).toBe(30);
    expect(planGap(4, 7, 0, now, true).target).toBe(4);
  });
  it('tops up at the next cron tick while the plan has gaps', () => {
    expect(planGap(4, 7, 2, now, true)).toEqual({ target: 4, gap: true, nextTopUpAt: '2026-09-21T12:00:00.000Z' });
  });
  it('has no top-up when the plan is full, paused or blocked', () => {
    expect(planGap(4, 7, 4, now, true).nextTopUpAt).toBeNull();
    expect(planGap(4, 7, 0, now, false)).toMatchObject({ gap: true, nextTopUpAt: null });
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
  it('offers the cheapest publishable kind when text cannot go anywhere', () => {
    expect(kindQueue(none, none, ['instagram'])).toEqual(['image']);
  });
  it('falls back to text once the mix is met', () => {
    expect(kindQueue({ text: 1, image: 1, video: 0 }, { text: 1, image: 1, video: 0 }, ['x'])).toEqual(['text']);
  });
});

describe('affordableKind', () => {
  it('drops to a cheaper kind rather than crossing the weekly cap', () => {
    // video is 25 (AGENT_VIDEO_CREDITS_ESTIMATE), text is 4
    expect(affordableKind(['video', 'text'], 1000, 20, 0)).toEqual({ kind: 'text' });
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

describe('mixFor', () => {
  it('splits one weekly number by preset', () => {
    expect(mixFor('text', 5, ['x'])).toEqual({ text: 5, image: 0, video: 0 });
    expect(mixFor('mixed', 7, ['x'])).toEqual({ text: 4, image: 2, video: 1 });
    expect(mixFor('video', 5, ['linkedin'])).toEqual({ text: 1, image: 1, video: 3 });
  });
  it('gives video-only and media-only platforms something they can post', () => {
    expect(mixFor('text', 5, ['x', 'tiktok'])).toEqual({ text: 4, image: 0, video: 1 });
    expect(mixFor('text', 3, ['instagram'])).toEqual({ text: 2, image: 1, video: 0 });
    expect(mixFor('mixed', 2, ['youtube']).video).toBeGreaterThan(0);
  });
  it('round-trips through presetOf', () => {
    expect(presetOf(mixFor('video', 6, ['x']), ['x'])).toBe('video');
    expect(presetOf({ text: 1, image: 5, video: 0 }, ['x'])).toBeNull();
  });
});

describe('platformCaps', () => {
  it('caps each platform at its recommendation, never above the weekly total', () => {
    expect(platformCaps(['x', 'youtube'], [], 3)).toEqual({ x: 3, youtube: 1 });
  });
});
