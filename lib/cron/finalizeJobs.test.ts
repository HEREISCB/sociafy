import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The sweep now has two callers (the /api/cron/finalize-video-jobs route and
 * `scripts/cron-run.mjs finalize-video-jobs`), so a regression here breaks both
 * and strands customer credits — the exact failure that motivated it.
 *
 * What matters is the selection, not the settling: which rows the sweep hands
 * to finalizeVideoJob / failImageJob (both of which do their own conditional
 * claim + refund, covered in lib/media/finalizeVideoJob.test.ts). So the drizzle
 * operators are stubbed as row predicates and the fake db actually applies them
 * — a fresh row is left alone because the predicate says so, not because the
 * fixture withheld it.
 */

const state = vi.hoisted(() => ({
  videos: [] as Record<string, unknown>[],
  images: [] as Record<string, unknown>[],
  /** Rows handed to the shared video finaliser, which fails + refunds them. */
  finalized: [] as string[],
  /** Rows handed to failImageJob, which fails + refunds them. */
  failedImages: [] as { id: string; error: string }[],
  dbStub: false,
  finalizeThrows: false,
}));

type Pred = (r: Record<string, unknown>) => boolean;

vi.mock('drizzle-orm', () => ({
  and: (...ps: Pred[]) => (r: Record<string, unknown>) => ps.every((p) => p(r)),
  eq: (col: { __c: string }, v: unknown) => (r: Record<string, unknown>) => r[col.__c] === v,
  lt: (col: { __c: string }, v: Date) => (r: Record<string, unknown>) => (r[col.__c] as Date) < v,
  asc: (col: { __c: string }) => col.__c,
}));

vi.mock('../db/schema', () => ({
  videoJobs: {
    __t: 'videos',
    id: { __c: 'id' },
    status: { __c: 'status' },
    updatedAt: { __c: 'updatedAt' },
  },
  genJobs: {
    __t: 'images',
    id: { __c: 'id' },
    kind: { __c: 'kind' },
    status: { __c: 'status' },
    createdAt: { __c: 'createdAt' },
  },
}));

vi.mock('../db', () => ({
  db: () => ({
    select: () => ({
      from: (t: { __t: 'videos' | 'images' }) => ({
        where: (pred: Pred) => ({
          orderBy: (col: string) => ({
            limit: (n: number) =>
              Promise.resolve(
                state[t.__t]
                  .filter(pred)
                  .sort((a, b) => (a[col] as Date).getTime() - (b[col] as Date).getTime())
                  .slice(0, n),
              ),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('../env', () => ({ isStubMode: { database: () => state.dbStub } }));

vi.mock('../media/finalizeVideoJob', () => ({
  finalizeVideoJob: (job: { id: string }) => {
    if (state.finalizeThrows) throw new Error('piapi exploded');
    state.finalized.push(job.id);
    return Promise.resolve({ status: 'failed', error: 'provider_stuck' });
  },
}));

vi.mock('../../app/api/v1/shared', () => ({
  IMAGE_JOB_KIND: 'image',
  failImageJob: (job: { id: string }, error: string) => {
    state.failedImages.push({ id: job.id, error });
    return Promise.resolve();
  },
}));

import { runFinalizeJobs } from './finalizeJobs';

const ago = (ms: number) => new Date(Date.now() - ms);

function video(id: string, over: Record<string, unknown> = {}) {
  return { id, status: 'pending', updatedAt: ago(5 * 60_000), ...over };
}
function image(id: string, over: Record<string, unknown> = {}) {
  return { id, kind: 'image', status: 'pending', createdAt: ago(30 * 60_000), ...over };
}

beforeEach(() => {
  state.videos = [];
  state.images = [];
  state.finalized = [];
  state.failedImages = [];
  state.dbStub = false;
  state.finalizeThrows = false;
});

describe('runFinalizeJobs — video jobs', () => {
  it('hands a stale pending job to the finaliser, which fails and refunds it', async () => {
    state.videos = [video('vid_stuck')];

    const out = await runFinalizeJobs();

    expect(state.finalized).toEqual(['vid_stuck']);
    expect(out.swept).toBe(1);
    expect(out.results).toEqual([{ id: 'vid_stuck', status: 'failed' }]);
  });

  it('leaves a job the browser poller just touched alone', async () => {
    // Inside MIN_IDLE_MS — a live tab is finalizing it right now.
    state.videos = [video('vid_fresh', { updatedAt: ago(5_000) })];

    const out = await runFinalizeJobs();

    expect(state.finalized).toEqual([]);
    expect(out.swept).toBe(0);
  });

  it('leaves terminal jobs alone', async () => {
    state.videos = [
      video('vid_done', { status: 'completed' }),
      video('vid_dead', { status: 'failed' }),
    ];
    await runFinalizeJobs();
    expect(state.finalized).toEqual([]);
  });

  it('records a thrown finalize as an error without abandoning the rest of the batch', async () => {
    state.videos = [video('vid_a'), video('vid_b')];
    state.finalizeThrows = true;

    const out = await runFinalizeJobs();

    expect(out.results.map((r) => r.status)).toEqual(['error', 'error']);
    expect(out.results[0].error).toContain('piapi exploded');
  });
});

describe('runFinalizeJobs — async image jobs', () => {
  it('fails and refunds an image job past the grace window', async () => {
    state.images = [image('img_lost')];

    const out = await runFinalizeJobs();

    expect(state.failedImages).toEqual([{ id: 'img_lost', error: 'generation_timeout' }]);
    expect(out.sweptImages).toBe(1);
  });

  it('leaves an image job still inside the grace window alone', async () => {
    // Under IMAGE_GRACE_MS: its after() callback may still be generating.
    state.images = [image('img_running', { createdAt: ago(60_000) })];

    const out = await runFinalizeJobs();

    expect(state.failedImages).toEqual([]);
    expect(out.sweptImages).toBe(0);
  });

  it('never touches a gen_jobs row of another kind', async () => {
    state.images = [image('tts_1', { kind: 'tts' }), image('avatar_1', { kind: 'avatar' })];
    await runFinalizeJobs();
    expect(state.failedImages).toEqual([]);
  });
});

describe('runFinalizeJobs — batch bound', () => {
  it('caps each kind at BATCH_LIMIT and flags that more remain', async () => {
    state.videos = Array.from({ length: 14 }, (_, i) => video(`vid_${i}`, { updatedAt: ago(600_000 + i) }));
    state.images = Array.from({ length: 12 }, (_, i) => image(`img_${i}`));

    const out = await runFinalizeJobs();

    expect(out.swept).toBe(10);
    expect(out.sweptImages).toBe(10);
    expect(out.moreLikely).toBe(true);
    expect(out.results).toHaveLength(20);
  });

  it('does not flag moreLikely when the batch was not full', async () => {
    state.videos = [video('vid_1')];
    const out = await runFinalizeJobs();
    expect(out.moreLikely).toBe(false);
  });

  it('takes the oldest jobs first so an overflowed batch still drains', async () => {
    // Newest first in the fixture — ordering must come from the query, not luck.
    state.videos = Array.from({ length: 12 }, (_, i) =>
      video(`vid_${i}`, { updatedAt: ago(120_000 + (12 - i) * 1000) }),
    );

    await runFinalizeJobs();

    expect(state.finalized[0]).toBe('vid_0');
    expect(state.finalized).toHaveLength(10);
  });
});

describe('runFinalizeJobs — no database', () => {
  it('skips instead of throwing when DATABASE_URL is unset', async () => {
    state.dbStub = true;
    state.videos = [video('vid_stuck')];

    const out = await runFinalizeJobs();

    expect(out.skipped).toBe('no_database');
    expect(state.finalized).toEqual([]);
  });
});
