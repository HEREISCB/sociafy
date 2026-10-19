import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Render slots are finite (the backend answers 429 at its limit). An autopilot
 * video that finds them full must wait for one — parked uncharged, then
 * submitted by the sweep — rather than silently becoming a text post.
 */

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

const state = vi.hoisted(() => ({
  videos: [] as Row[],
  drafts: [] as Row[],
  /** What each submitVideo call does: 'ok' | 'full' | '429' | 'boom'. */
  outcomes: [] as string[],
  submits: [] as Row[],
  /** attachFinishedVideos' join result. */
  joined: [] as { draft: Row; job: Row }[],
  assets: [] as Row[],
  settings: [] as Row[],
}));

vi.mock('drizzle-orm', () => ({
  and: (...ps: Pred[]) => (r: Row) => ps.every((p) => p(r)),
  eq: (c: { __c: string }, v: unknown) => (r: Row) => r[c.__c] === v,
  inArray: (c: { __c: string }, vs: unknown[]) => (r: Row) => vs.includes(r[c.__c]),
  asc: (c: { __c: string }) => c.__c,
}));
const col = vi.hoisted(() => (t: string, ...cs: string[]) => Object.fromEntries([['__t', t], ...cs.map((c) => [c, { __c: c }])]));
vi.mock('../db/schema', () => ({
  videoJobs: col('videos', 'id', 'status', 'createdAt'),
  drafts: col('drafts', 'id', 'status', 'videoJobId'),
  agentSettings: col('settings', 'userId'), genJobs: col('gen'), mediaAssets: col('assets', 'id'), activityLog: col('log'),
}));
vi.mock('../db', () => {
  const table = (t: { __t: 'videos' | 'drafts' | 'assets' | 'settings' }) => state[t.__t];
  return {
    db: () => ({
      select: () => ({
        from: (t: { __t: 'videos' | 'drafts' | 'assets' | 'settings' }) => ({
          innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve(state.joined) }) }),
          where: (p: Pred) => {
            const rows = () => table(t).filter(p);
            return { limit: (n: number) => Promise.resolve(rows().slice(0, n)), orderBy: () => ({ limit: (n: number) => Promise.resolve(rows().slice(0, n)) }) };
          },
        }),
      }),
      insert: (t: { __t: 'videos' }) => ({
        values: (v: Row) => ({
          returning: () => {
            const row = { id: `q${table(t).length + 1}`, createdAt: new Date(), ...v };
            table(t).push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
      update: (t: { __t: 'videos' | 'drafts' }) => ({
        set: (v: Row) => ({
          where: (p: Pred) => {
            const hit = table(t).filter(p);
            hit.forEach((r) => Object.assign(r, v));
            const done = Promise.resolve(hit);
            return Object.assign(done, { returning: () => done });
          },
        }),
      }),
      delete: (t: { __t: 'videos' }) => ({
        where: (p: Pred) => {
          state[t.__t] = table(t).filter((r) => !p(r));
          return Promise.resolve();
        },
      }),
    }),
  };
});

vi.mock('../../app/api/v1/shared', () => {
  class SubmitFailure extends Error {
    constructor(readonly code: string, readonly refunded: boolean, readonly detail: string) { super(`${code}: ${detail}`); }
  }
  return {
    SubmitFailure,
    insertImageJob: vi.fn(), runImageJob: vi.fn(), failImageJob: vi.fn(),
    submitVideo: (a: Row) => {
      state.submits.push(a);
      const o = state.outcomes.shift() ?? 'ok';
      if (o === 'full') return Promise.reject(new SubmitFailure('at_capacity', false, 'cinema slots busy: 3/3'));
      if (o === '429') return Promise.reject(new SubmitFailure('provider_rejected', true, 'piapi_429: too many tasks'));
      if (o === 'boom') return Promise.reject(new SubmitFailure('provider_rejected', true, 'cue_500: down'));
      return Promise.resolve({ job: { id: `real${state.submits.length}` }, creditsCharged: 22, replayed: false });
    },
  };
});
vi.mock('../ai/prompt-rewriter', async (orig) => ({
  ...(await orig<typeof import('../ai/prompt-rewriter')>()),
  rewritePromptForMedia: () => Promise.resolve({ prompt: 'A cup on a counter.', enhanced: true }),
}));
vi.mock('./publish', () => ({ publishOrHold: vi.fn() }));
vi.mock('./plan', async () => ({
  isApproved: (await vi.importActual<typeof import('./plan')>('./plan')).isApproved,
  queueApprovedRender: vi.fn(),
}));
vi.mock('../credits/ledger', () => ({ charge: vi.fn() }));

import { submitAgentVideo, submitQueuedVideos, attachFinishedVideos, VIDEO_QUEUED } from './media';
import { publishOrHold } from './publish';
import { queueApprovedRender } from './plan';

const post = { userId: 'u1', title: 't', body: 'b', brandBlock: '' };

beforeEach(() => {
  state.videos = []; state.drafts = []; state.outcomes = []; state.submits = [];
  state.joined = []; state.assets = []; state.settings = [];
  vi.mocked(publishOrHold).mockClear(); vi.mocked(queueApprovedRender).mockClear();
});

describe('submitAgentVideo', () => {
  it('renders on Motion, 9:16, without a Cinema Audio line', async () => {
    expect(await submitAgentVideo(post)).toBe('real1');
    expect(state.submits[0]).toMatchObject({ model: 'sociafy-motion-1', aspect: '9:16', fast: false, quality: '720p', via: 'autopilot' });
    expect(state.submits[0].durationSec).toBeGreaterThanOrEqual(4);
    expect(String(state.submits[0].prompt)).not.toMatch(/Audio:/);
  });

  it('parks an uncharged placeholder when the backend is at its limit', async () => {
    state.outcomes = ['429'];
    const id = await submitAgentVideo(post);
    expect(state.videos).toEqual([expect.objectContaining({ id, status: VIDEO_QUEUED, provider: 'piapi-seedance-2.5', providerTaskId: '' })]);
    expect(state.videos[0].creditLedgerId).toBeUndefined();
  });

  it('still throws on a real failure, so the post falls back to text', async () => {
    state.outcomes = ['boom'];
    await expect(submitAgentVideo(post)).rejects.toThrow(/provider_rejected/);
    expect(state.videos).toEqual([]);
  });
});

describe('submitQueuedVideos', () => {
  const park = (id: string, draftStatus = 'draft', provider = 'piapi-seedance-2.5') => {
    state.videos.push({ id, status: VIDEO_QUEUED, provider, prompt: 'p', createdAt: new Date() });
    state.drafts.push({ id: `d-${id}`, status: draftStatus, videoJobId: id });
  };

  it('submits when a slot frees, repoints the draft and drops the placeholder', async () => {
    park('q1');
    expect(await submitQueuedVideos()).toBe(1);
    expect(state.drafts[0].videoJobId).toBe('real1');
    expect(state.videos).toEqual([]);
    expect(state.submits[0].model).toBe('sociafy-motion-1');
  });

  it('renders a row parked before the switch on the Cinema it was queued for', async () => {
    park('q1', 'draft', 'cue-h3');
    expect(await submitQueuedVideos()).toBe(1);
    expect(state.submits[0].model).toBe('sociafy-cinema-1');
  });

  it('puts it back and stops at the first full slot', async () => {
    park('q1'); park('q2');
    state.outcomes = ['full'];
    expect(await submitQueuedVideos()).toBe(0);
    expect(state.submits).toHaveLength(1);
    expect(state.videos.map((v) => v.status)).toEqual([VIDEO_QUEUED, VIDEO_QUEUED]);
  });

  it('never renders for a post that stopped waiting', async () => {
    park('q1', 'archived');
    await submitQueuedVideos();
    expect(state.submits).toHaveLength(0);
    expect(state.videos[0]).toMatchObject({ status: 'failed', error: 'abandoned' });
  });

  it('gives up after a day', async () => {
    park('q1');
    state.videos[0].createdAt = new Date(Date.now() - 25 * 60 * 60_000);
    await submitQueuedVideos();
    expect(state.submits).toHaveLength(0);
    expect(state.videos[0]).toMatchObject({ status: 'failed', error: 'queue_timeout' });
  });
});

describe('attachFinishedVideos', () => {
  const land = (variants: Row[]) => {
    const draft = { id: 'd1', userId: 'u1', status: 'draft', videoJobId: 'j1', media: [], variants };
    state.drafts = [draft];
    state.assets = [{ id: 'a1', publicUrl: 'https://x/v.mp4', mimeType: 'video/mp4' }];
    state.settings = [{ userId: 'u1', quietHours: null }];
    state.joined = [{ draft: { ...draft }, job: { id: 'j1', status: 'completed', mediaAssetId: 'a1' } }];
  };

  it('schedules a render the user approved mid-render instead of re-reviewing it', async () => {
    land([{ label: 'A', text: 'b', score: 50, approved: true }]);
    await attachFinishedVideos();
    expect(queueApprovedRender).toHaveBeenCalledTimes(1);
    expect(publishOrHold).not.toHaveBeenCalled();
  });

  it('leaves an unapproved render to the autopilot decision', async () => {
    land([{ label: 'A', text: 'b', score: 50 }]);
    await attachFinishedVideos();
    expect(publishOrHold).toHaveBeenCalledTimes(1);
    expect(queueApprovedRender).not.toHaveBeenCalled();
  });

  it('attaches the clip to a user-made draft but leaves the post for the user to review', async () => {
    land([]);
    state.drafts[0].source = 'user';
    state.joined[0].draft.source = 'user';
    await attachFinishedVideos();
    expect(state.drafts[0]).toMatchObject({ videoJobId: null, media: [{ id: 'a1' }] });
    expect(publishOrHold).not.toHaveBeenCalled();
    expect(queueApprovedRender).not.toHaveBeenCalled();
  });
});
