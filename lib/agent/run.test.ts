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
          return { where: () => Promise.resolve([]) };
        },
      }),
    }),
  };
});

const draftFromTrends = vi.hoisted(() => vi.fn());
vi.mock('../ai/agent', () => ({ draftFromTrends }));
vi.mock('../credits/ledger', () => ({
  getBalance: async () => 1000,
  charge: async () => undefined,
}));

import { runAgentForUser } from './run';

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
  state.inserts = {};
  state.updates = [];
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
    state.recentSched = [{ platform: 'x' }]; // cap already used
    const res = await runAgentForUser('u1');
    expect(scheduled()).toEqual([]);
    expect(res.published).toBe(0);
    expect(res.held).toBe(1);
    expect(state.updates.some((u) => u.table === 'drafts' && u.values.status === 'scheduled')).toBe(false);
  });
});
