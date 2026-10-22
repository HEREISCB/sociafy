/**
 * Approving the plan: posts go out at their planned slot, a slot that passed
 * before the user got round to reviewing moves to the next free one, and every
 * query is scoped to the signed-in user.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  drafts: [] as Record<string, unknown>[],
  pending: [] as Record<string, unknown>[],
  accounts: [] as Record<string, unknown>[],
  /** Draft ids already claimed — a second claim returns no row. */
  claimed: new Set<string>(),
  inserts: {} as Record<string, Record<string, unknown>[]>,
  wheres: [] as { table: string; params: unknown[] }[],
  sets: [] as Record<string, unknown>[],
  /** Queued answers for successive drafts selects (then falls back to `drafts`). */
  draftReads: [] as Record<string, unknown>[][],
  /** An update whose where names this video job matches no row (the clip landed). */
  landedJob: null as string | null,
  deletes: [] as string[],
}));

vi.mock('../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = (t: any, w: any) => state.wheres.push({ table: getTableName(t), params: w ? dialect.sqlToQuery(w).params : [] });
  const rowsFor = (name: string) =>
    name === 'agent_settings' ? (state.settings ? [state.settings] : [])
    : name === 'drafts' ? (state.draftReads.shift() ?? state.drafts)
    : name === 'scheduled_posts' ? state.pending
    : name === 'connected_accounts' ? state.accounts
    : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = (rows: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = Promise.resolve(rows);
    p.limit = () => p;
    p.orderBy = () => p;
    return p;
  };
  return {
    db: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select: () => ({ from: (t: any) => ({ where: (w: any) => { record(t, w); return chain(rowsFor(getTableName(t))); } }) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insert: (t: any) => ({
        values: (v: Record<string, unknown>) => {
          (state.inserts[getTableName(t)] ??= []).push(v);
          return Promise.resolve([v]);
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete: (t: any) => ({ where: (w: any) => { record(t, w); state.deletes.push(getTableName(t)); return Promise.resolve([]); } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (t: any) => ({
        set: (v: Record<string, unknown>) => (state.sets.push(v), {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          where: (w: any) => {
            record(t, w);
            if (state.landedJob && dialect.sqlToQuery(w).params.includes(state.landedJob)) return { returning: () => Promise.resolve([]) };
            const id = dialect.sqlToQuery(w).params.find((p) => typeof p === 'string' && p.startsWith('d-')) as string;
            const hit = !state.claimed.has(id);
            state.claimed.add(id);
            return { returning: () => Promise.resolve(hit ? [{ id }] : []) };
          },
        }),
      }),
    }),
  };
});

import { approveDrafts, skipDraft, unapproveDrafts, getPlan, queueApprovedRender, isApproved, PLAN_MAX } from './plan';
import { draftCost } from '../credits/estimator';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-02T06:00:00Z'); // Monday
const draft = (id: string, over: Record<string, unknown> = {}) => ({
  id, userId: 'u1', title: id, body: 'body', status: 'draft', source: 'agent', media: [], videoJobId: null,
  targetPlatforms: ['x'], perPlatformText: {}, variants: [{ label: 'A', text: 'body' }], plannedAt: null,
  createdAt: NOW, ...over,
});
const posts = () => state.inserts['scheduled_posts'] ?? [];

beforeEach(() => {
  state.settings = { userId: 'u1', planHorizonDays: 7, quietHours: null, cadencePerWeek: 3, postsPerWeekByContentType: { text: 3, image: 0, video: 0 }, autoPublishThreshold: 101, enabled: true };
  state.drafts = [];
  state.pending = [];
  state.accounts = [{ id: 'acc-x', platform: 'x' }, { id: 'acc-li', platform: 'linkedin' }];
  state.claimed = new Set();
  state.inserts = {};
  state.wheres = [];
  state.sets = [];
  state.draftReads = [];
  state.landedJob = null;
  state.deletes = [];
});

describe('approve', () => {
  it('schedules a draft at its planned slot', async () => {
    const at = new Date(NOW.getTime() + 2 * DAY);
    state.drafts = [draft('d-1', { plannedAt: at })];
    const res = await approveDrafts('u1', { all: true }, NOW);
    expect(res.approved).toEqual([{ draftId: 'd-1', scheduledAt: at.toISOString(), platforms: ['x'], reslotted: false }]);
    expect(posts()[0].scheduledAt).toEqual(at);
  });

  it('a slot that passed unreviewed moves to the next free slot — never posts in the past', async () => {
    state.drafts = [draft('d-1', { plannedAt: new Date(NOW.getTime() - DAY) })];
    state.pending = [{ at: new Date('2026-03-02T09:30:00Z') }]; // the first window is taken
    const res = await approveDrafts('u1', { all: true }, NOW);
    expect(res.approved[0].reslotted).toBe(true);
    const at = new Date(res.approved[0].scheduledAt!);
    expect(at.getTime()).toBeGreaterThan(NOW.getTime());
    expect(Math.abs(at.getTime() - new Date('2026-03-02T09:30:00Z').getTime())).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });

  it('two overdue drafts do not land on the same slot', async () => {
    state.drafts = [draft('d-1', { plannedAt: new Date(NOW.getTime() - DAY) }), draft('d-2', { plannedAt: new Date(NOW.getTime() - DAY / 2) })];
    const res = await approveDrafts('u1', { all: true }, NOW);
    const [a, b] = res.approved.map((r) => new Date(r.scheduledAt!).getTime());
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });

  it('leaves out an account that needs reconnecting: the cron would fail that post for good at its slot', async () => {
    state.drafts = [draft('d-1', { plannedAt: new Date(NOW.getTime() + DAY), targetPlatforms: ['x', 'linkedin'] })];
    state.accounts = [
      { id: 'acc-x', platform: 'x', lastRefreshError: '401 invalid_grant', refreshToken: 'r' },
      { id: 'acc-li', platform: 'linkedin', tokenExpiresAt: new Date(Date.now() + 30 * DAY), refreshToken: null },
    ];
    const res = await approveDrafts('u1', { all: true }, NOW);
    expect(res.approved[0].platforms).toEqual(['linkedin']);
    expect(posts().map((p) => p.platform)).toEqual(['linkedin']);
  });

  it('every platform disconnected: not approved, and says why', async () => {
    state.drafts = [draft('d-1', { plannedAt: new Date(NOW.getTime() + DAY) })];
    state.accounts = [{ id: 'acc-x', platform: 'x', tokenExpiresAt: new Date(Date.now() - DAY), refreshToken: null }];
    const res = await approveDrafts('u1', { all: true }, NOW);
    expect(res.approved).toEqual([]);
    expect(res.skipped[0]).toMatchObject({ draftId: 'd-1', reasons: { x: 'disconnected' } });
  });

  it('uses the override time when given', async () => {
    const at = '2026-03-05T16:30:00.000Z';
    state.drafts = [draft('d-1', { plannedAt: new Date(NOW.getTime() + DAY) })];
    const res = await approveDrafts('u1', { draftIds: ['d-1'], overrides: { 'd-1': at } }, NOW);
    expect(res.approved[0].scheduledAt).toBe(at);
  });

  it('approves a video still rendering ahead of its clip: flagged, not queued yet', async () => {
    const at = new Date(NOW.getTime() + DAY);
    state.drafts = [draft('d-1', { videoJobId: 'job', plannedAt: at })];
    const res = await approveDrafts('u1', { all: true }, NOW);
    expect(res.approved).toEqual([{ draftId: 'd-1', scheduledAt: at.toISOString(), platforms: ['x'], reslotted: false, rendering: true }]);
    expect(posts()).toEqual([]);
    expect(isApproved({ variants: state.sets[0].variants as never })).toBe(true);
  });

  it('queues the post now when its clip landed between the read and the approve', async () => {
    const at = new Date(NOW.getTime() + DAY);
    const rendering = draft('d-1', { videoJobId: 'job', plannedAt: at, targetPlatforms: ['linkedin'] });
    const landed = draft('d-1', { plannedAt: at, targetPlatforms: ['linkedin'], media: [{ id: 'm', url: 'https://x/v.mp4', mimeType: 'video/mp4' }] });
    state.draftReads = [[rendering], [rendering], [landed]]; // rows, reserved, re-read
    state.landedJob = 'job';
    const res = await approveDrafts('u1', { all: true }, NOW);
    expect(res.approved).toEqual([{ draftId: 'd-1', scheduledAt: at.toISOString(), platforms: ['linkedin'], reslotted: false }]);
    expect(posts()).toHaveLength(1);
  });

  it('skips a draft whose text is over a platform limit, naming the platforms', async () => {
    state.drafts = [draft('d-1', { body: 'x'.repeat(281), variants: [], targetPlatforms: ['x', 'linkedin'], plannedAt: new Date(NOW.getTime() + DAY) })];
    const res = await approveDrafts('u1', { all: true }, NOW);
    expect(res.skipped).toEqual([{ draftId: 'd-1', reason: 'too_long', platforms: ['x'] }]);
    expect(posts()).toEqual([]);
  });

  it('a double-click queues the post once', async () => {
    state.drafts = [draft('d-1', { plannedAt: new Date(NOW.getTime() + DAY) })];
    await approveDrafts('u1', { all: true }, NOW);
    const second = await approveDrafts('u1', { all: true }, NOW);
    expect(second.skipped[0].reason).toBe('not_a_draft');
    expect(posts()).toHaveLength(1);
  });

  it('skips platforms the post type cannot go to, like POST /api/schedule', async () => {
    state.accounts.push({ id: 'acc-ig', platform: 'instagram' });
    state.drafts = [draft('d-1', { targetPlatforms: ['x', 'instagram'], plannedAt: new Date(NOW.getTime() + DAY) })];
    const res = await approveDrafts('u1', { all: true }, NOW);
    expect(res.approved[0].platforms).toEqual(['x']);
  });

  it('posts the edited body, not the model\'s stale per-platform copy — unless the user rewrote that platform', async () => {
    state.drafts = [draft('d-1', {
      targetPlatforms: ['x', 'linkedin'],
      body: 'edited by the user',
      variants: [{ label: 'A', text: 'model body', perPlatform: { x: 'model x', linkedin: 'model li' } }],
      perPlatformText: { x: 'model x', linkedin: 'user li' },
      plannedAt: new Date(NOW.getTime() + DAY),
    })];
    await approveDrafts('u1', { all: true }, NOW);
    expect(Object.fromEntries(posts().map((p) => [p.platform, p.text]))).toEqual({ x: 'edited by the user', linkedin: 'user li' });
  });

  it('keeps the model\'s per-platform copy when the body was not edited', async () => {
    state.drafts = [draft('d-1', {
      body: 'model body',
      variants: [{ label: 'A', text: 'model body', perPlatform: { x: 'model x' } }],
      perPlatformText: { x: 'model x' },
      plannedAt: new Date(NOW.getTime() + DAY),
    })];
    await approveDrafts('u1', { all: true }, NOW);
    expect(posts()[0].text).toBe('model x');
  });
});

describe('an approved render landing', () => {
  it('posts at its planned slot', async () => {
    const at = new Date(NOW.getTime() + DAY);
    const r = await queueApprovedRender(draft('d-1', { plannedAt: at }) as never, null, NOW);
    expect(r.queued).toEqual(['x']);
    expect(posts()[0].scheduledAt).toEqual(at);
  });

  it('moves to the next free slot when the planned one passed while rendering', async () => {
    await queueApprovedRender(draft('d-1', { plannedAt: new Date(NOW.getTime() - DAY) }) as never, null, NOW);
    expect((posts()[0].scheduledAt as Date).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('every query is scoped to the user', () => {
  const scoped = () => state.wheres.filter((w) => ['drafts', 'scheduled_posts', 'agent_settings', 'connected_accounts'].includes(w.table));

  it('approve, skip and the plan view never read or write outside the user', async () => {
    state.drafts = [draft('d-1', { plannedAt: new Date(NOW.getTime() + DAY) })];
    await approveDrafts('u1', { draftIds: ['d-1'] }, NOW);
    await skipDraft('u1', 'd-2');
    await getPlan('u1', NOW);
    expect(scoped().length).toBeGreaterThan(8);
    for (const w of scoped()) expect(w.params).toContain('u1');
  });
});

describe('unapprove (Undo approve)', () => {
  const was = '2026-03-03T09:00:00.000Z';

  it('removes the pending posts and puts the draft back in review at its old slot', async () => {
    state.drafts = [draft('d-1', { status: 'scheduled', plannedAt: new Date(NOW.getTime() + DAY) })];
    const res = await unapproveDrafts('u1', [{ draftId: 'd-1', plannedAt: was }]);
    expect(res).toEqual({ restored: ['d-1'], skipped: [] });
    expect(state.deletes).toEqual(['scheduled_posts']);
    expect(state.sets[0]).toMatchObject({ status: 'draft', plannedAt: new Date(was) });
    for (const w of state.wheres) expect(w.params).toContain('u1');
  });

  it('clears the approved-while-rendering marker, back to no time', async () => {
    state.drafts = [draft('d-1', { videoJobId: 'job', variants: [{ label: 'A', text: 'body', approved: true }] })];
    const res = await unapproveDrafts('u1', [{ draftId: 'd-1', plannedAt: null }]);
    expect(res.restored).toEqual(['d-1']);
    expect(isApproved({ variants: state.sets[0].variants as never })).toBe(false);
    expect(state.sets[0].plannedAt).toBeNull();
  });

  it('leaves a draft still in review alone', async () => {
    state.drafts = [draft('d-1')];
    expect((await unapproveDrafts('u1', [{ draftId: 'd-1', plannedAt: null }])).skipped).toEqual([{ draftId: 'd-1', reason: 'not_approved' }]);
    expect(state.sets).toEqual([]);
  });

  it('cannot take back a post that is already going out', async () => {
    state.drafts = [draft('d-1', { status: 'scheduled' })];
    state.pending = [{ id: 'row' }]; // a publishing/published row
    expect((await unapproveDrafts('u1', [{ draftId: 'd-1', plannedAt: null }])).skipped).toEqual([{ draftId: 'd-1', reason: 'already_posting' }]);
    expect(state.deletes).toEqual([]);
  });
});

describe('skip', () => {
  it('reports a draft that is not the user\'s (or not a draft) as not found', async () => {
    state.claimed.add('d-9');
    expect(await skipDraft('u1', 'd-9')).toBe(false);
    expect(await skipDraft('u1', 'd-1')).toBe(true);
  });
});

describe('the plan view', () => {
  it('counts what is missing and flags overdue and rendering drafts', async () => {
    state.drafts = [
      draft('d-1', { plannedAt: new Date(NOW.getTime() - DAY) }),
      draft('d-2', { plannedAt: new Date(NOW.getTime() + DAY), videoJobId: 'job' }),
    ];
    const v = await getPlan('u1', NOW);
    expect(v.counts).toMatchObject({ review: 2, overdue: 1, rendering: 1, target: 3, missing: 1 });
    expect(v.review[0]).toMatchObject({ id: 'd-1', overdue: true });
    expect(v.review[1]).toMatchObject({ id: 'd-2', rendering: true });
    expect(new Date(v.nextEmptySlot).getTime()).toBeGreaterThan(NOW.getTime());
    expect(v.mode).toBe('review');
  });

  it('counts recent unplanned agent drafts (pre-planning ones) toward the target', async () => {
    state.drafts = [draft('d-1'), draft('d-2'), draft('d-3', { createdAt: new Date(NOW.getTime() - 30 * DAY) })];
    const v = await getPlan('u1', NOW);
    expect(v.counts).toMatchObject({ target: 3, missing: 1 });
  });

  it('estimates what the next Generate costs, capped at PLAN_MAX posts', async () => {
    const v = await getPlan('u1', NOW);
    expect(v.estimatedCredits).toBe(3 * draftCost('text'));
    state.settings = { ...state.settings, postsPerWeekByContentType: { text: 100, image: 0, video: 0 } };
    expect((await getPlan('u1', NOW, 30)).estimatedCredits).toBe(PLAN_MAX * draftCost('text'));
  });

  it('a render approved ahead of its clip no longer counts as needing review', async () => {
    state.drafts = [draft('d-1', { videoJobId: 'job', variants: [{ label: 'A', text: 'body', approved: true }] })];
    const v = await getPlan('u1', NOW);
    expect(v.review[0]).toMatchObject({ rendering: true, approved: true });
    expect(v.counts.review).toBe(0);
  });
});
