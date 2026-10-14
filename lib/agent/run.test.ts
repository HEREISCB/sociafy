/**
 * Autopilot only posts where it was told to, and only when it is running.
 *
 * Two P0s live here:
 *  1. `enabledPlatforms: []` used to mean "every connected account" — and []
 *     is the column default, so any user who never finished onboarding had
 *     autopilot posting to all of their real accounts.
 *  2. `runAgentForUser` never checked `settings.enabled`, so the manual
 *     "Auto-draft from trends" button published for real while the UI showed
 *     Autopilot as Paused.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  trends: [] as Record<string, unknown>[],
  accounts: [] as Record<string, unknown>[],
  recentDrafts: [] as Record<string, unknown>[],
  recentSched: [] as Record<string, unknown>[],
  activity: [] as Record<string, unknown>[],
  claimFails: false,
  inserts: {} as Record<string, Record<string, unknown>[]>,
  updates: [] as { table: string; values: Record<string, unknown> }[],
}));

vi.mock('../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  const rowsFor = (name: string): Record<string, unknown>[] => {
    switch (name) {
      case 'agent_settings': return state.settings ? [state.settings] : [];
      case 'drafts': return state.recentDrafts;
      case 'trends': return state.trends;
      case 'connected_accounts': return state.accounts;
      case 'scheduled_posts': return state.recentSched;
      case 'activity_log': return state.activity;
      default: return [];
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = (rows: any) => {
    const p: any = Promise.resolve(rows);
    p.limit = () => Promise.resolve(rows);
    p.orderBy = () => p;
    return p;
  };
  return {
    db: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select: () => ({ from: (t: any) => ({ where: () => chain(rowsFor(getTableName(t))) }) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insert: (t: any) => ({
        values: (v: Record<string, unknown>) => {
          const name = getTableName(t);
          (state.inserts[name] ??= []).push(v);
          const row = [{ id: `${name}-${state.inserts[name].length}`, ...v }];
          return Object.assign(Promise.resolve(row), { returning: () => Promise.resolve(row) });
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (t: any) => ({
        set: (v: Record<string, unknown>) => {
          state.updates.push({ table: getTableName(t), values: v });
          // `.returning()` answers the run claim: one row = we own this run.
          return { where: () => Object.assign(Promise.resolve([]), { returning: () => Promise.resolve(state.claimFails ? [] : [{ userId: 'u1' }]) }) };
        },
      }),
    }),
  };
});

const draftFromTrends = vi.hoisted(() => vi.fn());
vi.mock('../ai/agent', () => ({ draftFromTrends }));
const generateAgentImage = vi.hoisted(() => vi.fn());
const submitAgentVideo = vi.hoisted(() => vi.fn());
vi.mock('./media', () => ({ generateAgentImage, submitAgentVideo }));
vi.mock('../credits/ledger', () => ({
  getBalance: async () => 1000,
  charge: async () => undefined,
}));

import { runAgentForUser, planPeriod } from './run';
import { draftCost } from '../credits/estimator';

const SETTINGS = {
  userId: 'u1',
  enabled: true,
  instructions: 'be useful',
  cadencePerWeek: 3,
  autoPublishThreshold: 80,
  quietHours: null,
  brandSafetyStrict: false,
  niches: ['tech'],
  voiceTemplate: 'me',
  enabledPlatforms: [] as string[],
  postsPerWeekByPlatform: {} as Record<string, number>,
};

const settingsWith = (over: Partial<typeof SETTINGS>) => ({ ...SETTINGS, ...over });

const scheduled = () => state.inserts['scheduled_posts'] ?? [];

beforeEach(() => {
  state.settings = settingsWith({});
  state.trends = [{ id: 't1', niche: 'tech', title: 'A trend', summary: null, sourceUrl: null }];
  state.accounts = [
    { id: 'acc-x', platform: 'x' },
    { id: 'acc-li', platform: 'linkedin' },
  ];
  state.recentDrafts = [];
  state.recentSched = [];
  state.activity = [];
  state.claimFails = false;
  state.inserts = {};
  state.updates = [];
  generateAgentImage.mockReset();
  submitAgentVideo.mockReset();
  draftFromTrends.mockReset();
  draftFromTrends.mockResolvedValue([
    { title: 'T', body: 'B', perPlatform: {}, score: 99, rationale: 'r', trendId: 't1' },
  ]);
});

describe('enabledPlatforms is an allow-list, not a wildcard', () => {
  it('schedules NOTHING when the user has no platforms enabled', async () => {
    state.settings = settingsWith({ enabledPlatforms: [] });
    const res = await runAgentForUser('u1');
    expect(res.reason).toBe('no_allowed_platforms');
    expect(res.published).toBe(0);
    expect(scheduled()).toEqual([]);
    // It never even asked the model for copy.
    expect(draftFromTrends).not.toHaveBeenCalled();
  });

  it('posts only to the platforms on the list, not every connected account', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'] });
    await runAgentForUser('u1');
    expect(scheduled().map((r) => r.platform)).toEqual(['x']);
  });
});

describe('a paused autopilot does not publish', () => {
  it('does nothing at all on the cron path', async () => {
    state.settings = settingsWith({ enabled: false, enabledPlatforms: ['x'] });
    const res = await runAgentForUser('u1');
    expect(res.reason).toBe('disabled');
    expect(draftFromTrends).not.toHaveBeenCalled();
    expect(scheduled()).toEqual([]);
  });

  it('the forced manual "draft" path drafts but never schedules a live post', async () => {
    state.settings = settingsWith({ enabled: false, enabledPlatforms: ['x'] });
    const res = await runAgentForUser('u1', { force: true });
    expect(res.drafted).toBe(1);
    expect(res.held).toBe(1);
    expect(res.published).toBe(0);
    expect(scheduled()).toEqual([]);
  });
});

describe('score gate', () => {
  it('an unrated (score 0) draft never auto-publishes, even at threshold 0', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'], autoPublishThreshold: 0 });
    draftFromTrends.mockResolvedValue([
      { title: 'T', body: 'placeholder', perPlatform: {}, score: 0, rationale: 'stub', trendId: 't1' },
    ]);
    const res = await runAgentForUser('u1');
    expect(res.published).toBe(0);
    expect(res.held).toBe(1);
    expect(scheduled()).toEqual([]);
  });
});

describe('weekly per-platform caps', () => {
  it('does not mark a draft scheduled when every platform was capped out', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'], postsPerWeekByPlatform: { x: 1 } });
    state.recentSched = [{ platform: 'x', draftId: 'old', scheduledAt: new Date(Date.now() - 86_400_000) }]; // cap already used
    const res = await runAgentForUser('u1');
    expect(scheduled()).toEqual([]);
    expect(res.published).toBe(0);
    expect(res.held).toBe(1);
    expect(state.updates.some((u) => u.table === 'drafts' && u.values.status === 'scheduled')).toBe(false);
  });
});

describe('pacing', () => {
  it('drafts nothing when the plan already holds the week', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'] }); // cadence 3
    state.recentDrafts = [1, 2, 3].map((d) => ({ plannedAt: new Date(Date.now() + d * 86_400_000), media: [] }));
    const res = await runAgentForUser('u1');
    expect(res.reason).toBe('plan_full');
    expect(draftFromTrends).not.toHaveBeenCalled();
  });

  it('stops at the weekly credit cap, but a manual run still drafts', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'], weeklyCreditCap: 0 } as never);
    expect((await runAgentForUser('u1')).reason).toBe('credit_cap');
    expect((await runAgentForUser('u1', { force: true })).drafted).toBe(1);
  });
});

describe('image and video posts', () => {
  const IMG = { id: 'm1', url: 'https://cdn/x.png', mimeType: 'image/png' };

  it('attaches the generated image to the draft and to the scheduled post', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'], postsPerWeekByContentType: { text: 0, image: 3, video: 0 } } as never);
    generateAgentImage.mockResolvedValue(IMG);
    const res = await runAgentForUser('u1');
    expect(res.published).toBe(1);
    expect(state.inserts['drafts'][0].media).toEqual([IMG]);
    expect(scheduled()[0].media).toEqual([IMG]);
  });

  it('holds a video post until its render lands instead of posting it bare', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['linkedin'], postsPerWeekByContentType: { text: 0, image: 0, video: 1 } } as never);
    submitAgentVideo.mockResolvedValue('job-1');
    const res = await runAgentForUser('u1');
    expect(state.inserts['drafts'][0].videoJobId).toBe('job-1');
    expect(res.held).toBe(1);
    expect(scheduled()).toEqual([]);
  });

  it('never schedules a text post to a platform that rejects text', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x', 'instagram'] });
    state.accounts = [{ id: 'acc-x', platform: 'x' }, { id: 'acc-ig', platform: 'instagram' }];
    await runAgentForUser('u1');
    expect(scheduled().map((r) => r.platform)).toEqual(['x']);
  });

  it('keeps the post as text when the image fails', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'], postsPerWeekByContentType: { text: 0, image: 3, video: 0 } } as never);
    generateAgentImage.mockResolvedValue(null);
    await runAgentForUser('u1');
    expect(state.inserts['drafts'][0].media).toEqual([]);
    expect(scheduled()).toHaveLength(1);
  });
});

describe('when autopilot is on but cannot draft', () => {
  const notes = () => (state.inserts['activity_log'] ?? []).filter((r) => r.kind === 'agent_skipped');

  it('tells the user what to fix', async () => {
    state.settings = settingsWith({ enabledPlatforms: [] });
    await runAgentForUser('u1');
    expect(notes()).toHaveLength(1);
    expect((notes()[0].meta as { note: string }).note).toBe('no_platforms');
  });

  it('does not repeat itself every cron tick', async () => {
    state.settings = settingsWith({ enabledPlatforms: [] });
    state.activity = [{ id: 'already-told' }];
    await runAgentForUser('u1');
    expect(notes()).toEqual([]);
  });

  it('asks for niches before anything else', async () => {
    state.settings = settingsWith({ niches: [], enabledPlatforms: ['x'] });
    expect((await runAgentForUser('u1')).reason).toBe('no_niches');
  });
});

describe('the content mix is the weekly plan', () => {
  it('keeps drafting past cadencePerWeek when the mix asks for more', async () => {
    // cadence says 1, mix says 7: one draft 2 days ago is not "budget met".
    state.settings = settingsWith({ cadencePerWeek: 1, enabledPlatforms: ['x'], postsPerWeekByContentType: { text: 7, image: 0, video: 0 } } as never);
    state.recentDrafts = [{ plannedAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), media: [] }];
    expect((await runAgentForUser('u1')).drafted).toBe(1);
  });
});

describe('overlapping runs', () => {
  it('drafts nothing when another run already claimed this user', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'] });
    state.claimFails = true;
    const res = await runAgentForUser('u1');
    expect(res.reason).toBe('already_running');
    expect(draftFromTrends).not.toHaveBeenCalled();
  });
});

describe('the plan', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const drafts = () => state.inserts['drafts'] ?? [];
  beforeEach(() => {
    // The model writes as many posts as it is asked for.
    draftFromTrends.mockImplementation(async ({ count }: { count: number }) =>
      Array.from({ length: count }, (_, i) => ({ title: `T${i}`, body: `B${i}`, perPlatform: {}, score: 99, rationale: 'r', trendId: `t${i}` })));
  });

  it('the cron tops up a few posts per tick, each with its own slot inside the horizon', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'], postsPerWeekByContentType: { text: 7, image: 0, video: 0 } } as never);
    const res = await runAgentForUser('u1');
    expect(res.drafted).toBe(3);
    const at = drafts().map((d) => (d.plannedAt as Date).getTime());
    expect(new Set(at).size).toBe(3);
    for (const t of at) expect(t > Date.now() && t < Date.now() + 7 * DAY).toBe(true);
  });

  it('a 30-day plan drafts weekly target × weeks, a few posts per model call', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'], postsPerWeekByContentType: { text: 7, image: 0, video: 0 } } as never);
    const res = await planPeriod('u1', { horizonDays: 30 });
    expect(res.drafted).toBe(30);
    expect(draftFromTrends.mock.calls.length).toBeGreaterThan(1);
    for (const c of draftFromTrends.mock.calls) expect(c[0].count).toBeLessThanOrEqual(4);
    const last = Math.max(...drafts().map((d) => (d.plannedAt as Date).getTime()));
    expect(last).toBeGreaterThan(Date.now() + 25 * DAY);
  });

  it('counts what is already planned or queued against the target', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'], postsPerWeekByContentType: { text: 5, image: 0, video: 0 } } as never);
    state.recentDrafts = [{ plannedAt: new Date(Date.now() - DAY), media: [] }]; // overdue, still unreviewed
    state.recentSched = [
      { draftId: 'd1', platform: 'x', scheduledAt: new Date(Date.now() + DAY), media: [] },
      { draftId: 'd1', platform: 'linkedin', scheduledAt: new Date(Date.now() + DAY), media: [] },
    ];
    expect((await planPeriod('u1')).drafted).toBe(3); // 5 − 1 overdue − 1 queued post
  });

  it('scales the weekly credit cap to the horizon', async () => {
    const cap = draftCost('text');
    state.settings = settingsWith({ enabledPlatforms: ['x'], weeklyCreditCap: cap, postsPerWeekByContentType: { text: 7, image: 0, video: 0 } } as never);
    expect((await planPeriod('u1', { horizonDays: 7 })).drafted).toBe(1);
    state.inserts = {};
    expect((await planPeriod('u1', { horizonDays: 30 })).drafted).toBe(4);
  });

  it('auto mode schedules each post AT its planned slot, not now', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'] });
    await planPeriod('u1');
    expect(scheduled().length).toBe(3);
    scheduled().forEach((p, i) => expect(p.scheduledAt).toEqual(drafts()[i].plannedAt));
    expect(Math.max(...scheduled().map((p) => (p.scheduledAt as Date).getTime()))).toBeGreaterThan(Date.now() + DAY);
  });

  it('review mode leaves every post waiting with its slot', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'], autoPublishThreshold: 101 });
    const res = await planPeriod('u1');
    expect(res.held).toBe(3);
    expect(scheduled()).toEqual([]);
    for (const d of drafts()) expect(d.plannedAt).toBeInstanceOf(Date);
  });

  it('gives videos the latest slots — their render needs the head start', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['linkedin'], autoPublishThreshold: 101, postsPerWeekByContentType: { text: 2, image: 0, video: 1 } } as never);
    submitAgentVideo.mockResolvedValue('job-1');
    await planPeriod('u1');
    const video = drafts().find((d) => d.videoJobId)!;
    const latest = Math.max(...drafts().map((d) => (d.plannedAt as Date).getTime()));
    expect((video.plannedAt as Date).getTime()).toBe(latest);
  });

  it('refuses to run twice at once', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'] });
    state.claimFails = true;
    expect((await planPeriod('u1')).reason).toBe('already_running');
    expect(draftFromTrends).not.toHaveBeenCalled();
  });

  it('snapshots the model\'s per-platform copy on the variant', async () => {
    state.settings = settingsWith({ enabledPlatforms: ['x'] });
    draftFromTrends.mockResolvedValue([{ title: 'T', body: 'B', perPlatform: { x: 'short' }, score: 99, rationale: 'r', trendId: 't1' }]);
    await runAgentForUser('u1', { force: true });
    expect((drafts()[0].variants as { perPlatform?: unknown }[])[0].perPlatform).toEqual({ x: 'short' });
  });
});
