import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Covers the money-critical invariant: two concurrent finalizes of the same
 * job must produce ONE media asset and ONE refund. The conditional UPDATE is
 * modelled by a tiny in-memory row store so the claim can actually lose.
 */

const state = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  assets: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  partials: [] as Record<string, unknown>[],
  uploads: 0,
  /** How many times the completion ran as one transaction. */
  transactions: 0,
  uploadFails: false,
  r2Stub: false,
  cueStub: false,
  cueDeletes: [] as string[],
  cueDownloadStatus: 0,
  cueRender: { status: 'done' } as { status: string; error?: string },
  motionConfigured: true,
  motionAiConfigured: true,
  saved: [] as { job: Record<string, unknown>; r: Record<string, unknown> }[],
  savedWarning: undefined as string | undefined,
  motionAiResult: { status: 'done', videoKey: 'users/user_1/motion-ai.mp4', sizeBytes: 456 } as Record<string, unknown>,
  motionResult: { status: 'done', videoKey: 'users/user_1/motion.mp4', sizeBytes: 123 } as Record<string, unknown>,
  task: { status: 'completed', videoUrl: 'https://cdn.piapi/x.mp4' } as
    { status: string; videoUrl?: string; error?: string },
}));

// The mock db models exactly what finalizeVideoJob needs: selects return the
// current row, and update() applies the predicate against it so a conditional
// claim returns [] when the row no longer qualifies. `transaction` hands back the
// same client — the claim/insert/link must go through `tx`, and nothing in the
// finaliser depends on a rollback (a lost claim inserts nothing at all).
vi.mock('../db', () => {
  const client = {
    select: () => ({
      from: (t: { __t?: string }) => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => ({
          limit: () => Promise.resolve(
            t.__t === 'assets'
              ? state.assets.filter((a) => pred(a))
              : state.job && pred(state.job) ? [state.job] : [],
          ),
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          const row = { id: `asset_${state.assets.length + 1}`, ...v };
          state.assets.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => {
          const hit = !!state.job && pred(state.job);
          if (hit) {
            Object.assign(state.job!, v);
            state.updates.push(v);
          }
          return {
            returning: () => Promise.resolve(hit ? [{ id: state.job!.id }] : []),
            then: (r: (x: unknown) => unknown) => Promise.resolve(undefined).then(r),
          };
        },
      }),
    }),
  };
  return {
    db: () => ({
      ...client,
      transaction: (fn: (tx: typeof client) => unknown) => {
        state.transactions += 1;
        return Promise.resolve(fn(client));
      },
    }),
  };
});

// Predicate-building drizzle stubs — each returns a row predicate.
vi.mock('drizzle-orm', () => ({
  and: (...ps: ((r: Record<string, unknown>) => boolean)[]) => (r: Record<string, unknown>) => ps.every((p) => p(r)),
  eq: (col: { __c: string }, v: unknown) => (r: Record<string, unknown>) => r[col.__c] === v,
  ne: (col: { __c: string }, v: unknown) => (r: Record<string, unknown>) => r[col.__c] !== v,
  notInArray: (col: { __c: string }, vs: unknown[]) => (r: Record<string, unknown>) => !vs.includes(r[col.__c]),
}));

vi.mock('../db/schema', () => ({
  videoJobs: { __t: 'jobs', id: { __c: 'id' }, status: { __c: 'status' }, userId: { __c: 'userId' } },
  mediaAssets: { __t: 'assets', id: { __c: 'id' } },
}));

vi.mock('../ai/piapi', () => ({ getSeedanceTask: () => Promise.resolve(state.task) }));
// The Cinema backend. CueError must be a real class — the finaliser branches on
// `instanceof` to tell "not ready yet" (409) from an actual failure.
vi.mock('../ai/cue', () => {
  class CueError extends Error {
    constructor(readonly status: number, readonly detail: string) { super(`cue_${status}`); }
  }
  return {
    CueError,
    getCueRender: () => Promise.resolve(state.cueRender),
    downloadCueRender: () => state.cueDownloadStatus
      ? Promise.reject(new CueError(state.cueDownloadStatus, 'nope'))
      : Promise.resolve({ buffer: Buffer.from('mp4-with-audio'), contentType: 'video/mp4' }),
    deleteCueRender: (id: string) => { state.cueDeletes.push(id); return Promise.resolve(); },
  };
});
vi.mock('../ai/motion', () => ({
  motionConfigured: () => state.motionConfigured,
  getMotionResult: () => Promise.resolve(state.motionResult),
}));
vi.mock('../ai/motionAi', () => ({
  motionAiConfigured: () => state.motionAiConfigured,
  getMotionAiResult: () => Promise.resolve(state.motionAiResult),
}));
vi.mock('./motionVersions', () => ({
  cleanAudio: (a: unknown) => a ?? null,
  savedAudioWarning: () => Promise.resolve(state.savedWarning),
  saveMotionResult: (job: Record<string, unknown>, r: Record<string, unknown>) => { state.saved.push({ job, r }); return Promise.resolve(); },
}));
vi.mock('../storage/r2', () => ({
  makeMediaKey: (u: string, n: string) => `users/${u}/${n}`,
  publicUrlFor: (k: string) => `https://cdn.test/${k}`,
  uploadBuffer: () => {
    if (state.uploadFails) return Promise.reject(new Error('AccessDenied'));
    state.uploads += 1;
    return Promise.resolve();
  },
}));
vi.mock('./finalize', () => ({
  downloadToBuffer: () => Promise.resolve({ buffer: Buffer.from('mp4'), contentType: 'video/mp4' }),
}));
vi.mock('../credits/ledger', () => ({
  refund: (a: Record<string, unknown>) => { state.refunds.push(a); return Promise.resolve({ refunded: true }); },
  partialRefund: (a: Record<string, unknown>) => { state.partials.push(a); return Promise.resolve({ balanceAfter: 0 }); },
}));
vi.mock('../env', () => ({ isStubMode: { r2: () => state.r2Stub, cue: () => state.cueStub } }));

import { finalizeVideoJob, type VideoJob } from './finalizeVideoJob';

function job(over: Record<string, unknown> = {}) {
  state.job = {
    id: 'job_1',
    userId: 'user_1',
    status: 'pending',
    provider: 'piapi-seedance-2',
    providerTaskId: 'task_1',
    prompt: 'a cat',
    rewrittenPrompt: 'a cat, dolly in',
    durationSec: 8,
    mediaAssetId: null,
    creditLedgerId: 'led_1',
    error: null,
    createdAt: new Date(),
    ...over,
  };
  return state.job as unknown as VideoJob;
}

beforeEach(() => {
  process.env.PIAPI_API_KEY = 'k';
  state.assets = []; state.updates = []; state.refunds = []; state.partials = []; state.uploads = 0;
  state.transactions = 0; state.uploadFails = false; state.r2Stub = false;
  state.task = { status: 'completed', videoUrl: 'https://cdn.piapi/x.mp4' };
  process.env.CUE_API_KEY = 'k';
  state.cueStub = false; state.cueDeletes = []; state.cueDownloadStatus = 0;
  state.cueRender = { status: 'done' };
  state.motionConfigured = true;
  state.motionAiConfigured = true;
  state.saved = []; state.savedWarning = undefined;
  state.motionAiResult = { status: 'done', videoKey: 'users/user_1/motion-ai.mp4', sizeBytes: 456 };
  state.motionResult = { status: 'done', videoKey: 'users/user_1/motion.mp4', sizeBytes: 123 };
});

describe('finalizeVideoJob', () => {
  it('stores the clip and claims the row on the first finalize', async () => {
    const snapshot = job();
    const res = await finalizeVideoJob(snapshot);
    expect(res.status).toBe('completed');
    expect(state.assets).toHaveLength(1);
    expect(state.job!.status).toBe('completed');
    expect(state.job!.mediaAssetId).toBe('asset_1');
  });

  // The paid-work-loss bug: as three separate commits the row was briefly
  // 'completed' with mediaAssetId null, which the API reports as a completion
  // carrying no url. One transaction is what makes the pair inseparable.
  it('never reports completed without a resolvable url, and commits both together', async () => {
    const res = await finalizeVideoJob(job());
    expect(res.status).toBe('completed');
    expect((res as { asset?: { publicUrl?: string } }).asset?.publicUrl).toMatch(/^https:\/\/cdn\.test\//);
    // status and mediaAssetId were written inside one transaction, and the R2
    // upload stayed outside it.
    expect(state.transactions).toBe(1);
    expect(state.uploads).toBe(1);
    expect(state.job!.status).toBe('completed');
    expect(state.job!.mediaAssetId).toBe('asset_1');
  });

  it('reports a completed row that carries no asset as pending, never as completed', async () => {
    // Seeded directly: the state a pre-transaction ordering slip would leave.
    const res = await finalizeVideoJob(job({ status: 'completed', mediaAssetId: null }));
    expect(res).toEqual({ status: 'pending', providerStatus: 'finalizing' });
  });

  it('inserts no second asset and no second refund when the claim is lost', async () => {
    // A cron tick won the claim while this caller was still uploading.
    const stale = job();
    const snapshot = { ...stale } as VideoJob;
    state.job!.status = 'completed';
    state.job!.mediaAssetId = 'asset_winner';
    state.assets.push({ id: 'asset_winner', publicUrl: 'https://cdn.test/winner.mp4' });

    const res = await finalizeVideoJob(snapshot);
    expect(res.status).toBe('completed');
    expect((res as { asset?: { id: string } }).asset?.id).toBe('asset_winner');
    expect(state.assets).toHaveLength(1); // no orphan from the loser
    expect(state.refunds).toHaveLength(0);
  });

  it('terminates a genuine provider failure immediately with its reason', async () => {
    state.task = { status: 'failed', error: 'nsfw' };
    const res = await finalizeVideoJob(job());
    expect(res.status).toBe('failed');
    expect((res as { error: string }).error).toContain('piapi_failed');
    expect(state.job!.status).toBe('failed');
    // And it stays failed on a re-poll — never pending forever.
    expect((await finalizeVideoJob(state.job as unknown as VideoJob)).status).toBe('failed');
    expect(state.refunds).toHaveLength(1);
  });

  it('is a no-op for a second finalize racing on the same stale snapshot', async () => {
    // Both callers read the row while it was 'pending' — the classic double
    // finalize. Only one may write an asset row.
    const snapshot = job();
    const stale = { ...snapshot } as VideoJob;
    await finalizeVideoJob(snapshot);
    const res = await finalizeVideoJob(stale);
    expect(res.status).toBe('completed');
    expect(state.assets).toHaveLength(1);          // no duplicate asset
    expect((res as { asset?: { id: string } }).asset?.id).toBe('asset_1');
  });

  it('refunds exactly once when two finalizes see a failed task', async () => {
    state.task = { status: 'failed', error: 'nsfw' };
    const snapshot = job();
    const stale = { ...snapshot } as VideoJob;
    await finalizeVideoJob(snapshot);
    await finalizeVideoJob(stale);
    expect(state.refunds).toHaveLength(1);
    expect(state.job!.status).toBe('failed');
  });

  it('fails and refunds when the R2 upload throws, not just the download', async () => {
    state.uploadFails = true;
    const res = await finalizeVideoJob(job());
    expect(res.status).toBe('failed');
    expect(state.refunds).toHaveLength(1);
    expect(state.assets).toHaveLength(0);
  });

  it('holds an unconfirmed submit pending inside the grace window', async () => {
    const res = await finalizeVideoJob(job({ providerTaskId: '' }));
    expect(res).toEqual({ status: 'pending', providerStatus: 'submitting' });
    expect(state.refunds).toHaveLength(0);
  });

  it('refunds an unconfirmed submit once the grace window expires', async () => {
    const res = await finalizeVideoJob(job({
      providerTaskId: '',
      createdAt: new Date(Date.now() - 30 * 60_000),
    }));
    expect(res.status).toBe('failed');
    expect(state.refunds[0].reason).toContain('submit_unconfirmed');
  });

  it('leaves a render parked for a slot alone, however old', async () => {
    const res = await finalizeVideoJob(job({
      status: 'queued', provider: 'cue-h3', providerTaskId: '', creditLedgerId: null,
      createdAt: new Date(Date.now() - 30 * 60_000),
    }));
    expect(res).toEqual({ status: 'pending', providerStatus: 'queued' });
    expect(state.updates).toHaveLength(0);
  });

  it('stays pending (no refund, no store) when R2 is unconfigured', async () => {
    state.r2Stub = true;
    const res = await finalizeVideoJob(job());
    expect(res).toEqual({ status: 'pending', pollError: 'r2_not_configured' });
    expect(state.refunds).toHaveLength(0);
    expect(state.uploads).toBe(0);
  });
});

describe('finalizeVideoJob · Sociafy Cinema', () => {
  const cinemaJob = (over: Record<string, unknown> = {}) =>
    job({ provider: 'cue-h3', providerTaskId: 'render_abc', ...over });

  it('stores the render, claims the row, and drops the vendor copy', async () => {
    const r = await finalizeVideoJob(cinemaJob());
    expect(r.status).toBe('completed');
    expect(state.uploads).toBe(1);
    expect(state.assets).toHaveLength(1);
    expect(state.transactions).toBe(1);
    // Only after our copy is committed — deleting first would destroy the one
    // copy if the claim then lost its race.
    expect(state.cueDeletes).toEqual(['render_abc']);
  });

  it('never reaches the other backend — no key for it required', async () => {
    delete process.env.PIAPI_API_KEY;
    const r = await finalizeVideoJob(cinemaJob());
    expect(r.status).toBe('completed');
  });

  it('treats a 409 on the file as not-ready, not as a failure', async () => {
    // The backend answers 409 until the render settles. Reading that as a
    // failure would refund a render that is about to succeed and throw the
    // finished clip away.
    state.cueDownloadStatus = 409;
    const r = await finalizeVideoJob(cinemaJob());
    expect(r.status).toBe('pending');
    expect(state.refunds).toHaveLength(0);
    expect(state.assets).toHaveLength(0);
  });

  it('stays pending while the render is still running', async () => {
    state.cueRender = { status: 'running' };
    const r = await finalizeVideoJob(cinemaJob());
    expect(r.status).toBe('pending');
    expect(state.refunds).toHaveLength(0);
  });

  it('refunds exactly once when the render fails', async () => {
    state.cueRender = { status: 'failed', error: 'screening declined' };
    const first = cinemaJob();
    const snapshot = { ...first } as unknown as typeof first;
    const [a, b] = await Promise.all([finalizeVideoJob(first), finalizeVideoJob(snapshot)]);
    expect([a.status, b.status]).toEqual(['failed', 'failed']);
    expect(state.refunds).toHaveLength(1);
    // The vendor's own words must not become our error string.
    expect(state.job!.error).toContain('cinema_failed');
  });

  it('gives up and refunds once a render is past the give-up window', async () => {
    // A download that keeps erroring must still age out, or the job is
    // immortal and the customer's credits are held forever.
    state.cueDownloadStatus = 404;
    const r = await finalizeVideoJob(cinemaJob({ createdAt: new Date(Date.now() - 7 * 60 * 60_000) }));
    expect(r.status).toBe('failed');
    expect(state.refunds).toHaveLength(1);
  });

  it('stays pending, storing nothing, when the backend is unconfigured', async () => {
    state.cueStub = true;
    const r = await finalizeVideoJob(cinemaJob());
    expect(r.status).toBe('pending');
    expect(state.uploads).toBe(0);
    expect(state.refunds).toHaveLength(0);
  });
});

describe('finalizeVideoJob — motion graphics', () => {
  const motionJob = (over: Record<string, unknown> = {}) =>
    job({ provider: 'motion-hf', providerTaskId: 'fc-1', durationSec: 15, ...over });

  it('claims the asset at the engine-uploaded key without moving any bytes', async () => {
    const r = await finalizeVideoJob(motionJob());
    expect(r.status).toBe('completed');
    expect(state.uploads).toBe(0);
    expect(state.assets[0]).toMatchObject({ storageKey: 'users/user_1/motion.mp4', sizeBytes: 123, publicUrl: 'https://cdn.test/users/user_1/motion.mp4' });
    expect(state.job!.mediaAssetId).toBe('asset_1');
  });

  it('stays pending (no refund) while rendering', async () => {
    state.motionResult = { status: 'pending' };
    const r = await finalizeVideoJob(motionJob());
    expect(r).toEqual({ status: 'pending', providerStatus: 'processing' });
    expect(state.refunds).toHaveLength(0);
  });

  it('refunds exactly once on failure, with a non-public error string', async () => {
    state.motionResult = { status: 'failed', error: 'render_failed: chrome crashed' };
    const first = motionJob();
    const snapshot = { ...first } as unknown as typeof first;
    const [a, b] = await Promise.all([finalizeVideoJob(first), finalizeVideoJob(snapshot)]);
    expect([a.status, b.status]).toEqual(['failed', 'failed']);
    expect(state.refunds).toHaveLength(1);
    expect(state.job!.error).toMatch(/^motion_failed/);
  });

  it('refuses a result key outside the user prefix, and refunds', async () => {
    state.motionResult = { status: 'done', videoKey: 'users/someone_else/x.mp4' };
    const r = await finalizeVideoJob(motionJob());
    expect(r.status).toBe('failed');
    expect(state.assets).toHaveLength(0);
    expect(state.refunds).toHaveLength(1);
  });

  it('refunds an unconfirmed submit after the grace window', async () => {
    const r = await finalizeVideoJob(motionJob({ providerTaskId: '', createdAt: new Date(Date.now() - 11 * 60_000) }));
    expect(r.status).toBe('failed');
    expect(state.refunds).toHaveLength(1);
  });

  it('stays pending, touching nothing, when the engine is unconfigured', async () => {
    state.motionConfigured = false;
    const r = await finalizeVideoJob(motionJob());
    expect(r.status).toBe('pending');
    expect(state.refunds).toHaveLength(0);
    expect(state.assets).toHaveLength(0);
  });
});

describe('finalizeVideoJob — AI-designed motion graphics', () => {
  const aiJob = (over: Record<string, unknown> = {}) =>
    job({ provider: 'motion-claude', providerTaskId: 'ai-1', durationSec: 15, genMode: 'motion-ai', ...over });

  it('claims the worker-uploaded key as the asset', async () => {
    state.motionConfigured = false; // the template engine's flag must not matter
    const r = await finalizeVideoJob(aiJob());
    expect(r.status).toBe('completed');
    expect(state.uploads).toBe(0);
    expect(state.assets[0]).toMatchObject({ storageKey: 'users/user_1/motion-ai.mp4', sizeBytes: 456 });
  });

  it('stays pending at 20 minutes, refunds once on failure, guards the key prefix', async () => {
    state.motionAiResult = { status: 'pending' };
    expect((await finalizeVideoJob(aiJob({ createdAt: new Date(Date.now() - 20 * 60_000) }))).status).toBe('pending');
    expect(state.refunds).toHaveLength(0);

    state.motionAiResult = { status: 'failed', error: 'authoring failed' };
    expect(await finalizeVideoJob(aiJob())).toMatchObject({ status: 'failed', error: expect.stringMatching(/^motion_failed/) });
    expect(state.refunds).toHaveLength(1);

    state.refunds = [];
    state.motionAiResult = { status: 'done', videoKey: 'users/other/x.mp4' };
    expect((await finalizeVideoJob(aiJob())).status).toBe('failed');
    expect(state.assets).toHaveLength(0);
    expect(state.refunds).toHaveLength(1);
  });

  it('stores the segments of a finished render — original or edit — and only once it is claimed', async () => {
    const segments = [{ id: 's1', label: 'Hook', startSec: 0, endSec: 3, onScreenText: 'Hi', suggestions: ['Bigger'] }];
    state.motionAiResult = { status: 'done', videoKey: 'users/user_1/motion-ai.mp4', posterKey: 'users/user_1/p.jpg', segments };
    expect((await finalizeVideoJob(aiJob({ genMode: 'motion-ai-edit' }))).status).toBe('completed');
    expect(state.saved).toEqual([{ job: expect.objectContaining({ id: 'job_1' }), r: expect.objectContaining({ segments, posterKey: 'users/user_1/p.jpg' }) }]);

    state.saved = []; state.savedWarning = undefined;
    state.motionAiResult = { status: 'failed', error: 'x' };
    await finalizeVideoJob(aiJob());
    expect(state.saved).toHaveLength(0);
  });

  it('reports an audio warning on the completion — fresh, and again once already claimed', async () => {
    state.motionAiResult = { status: 'done', videoKey: 'users/user_1/motion-ai.mp4', audio: { narration: false, sfx: false, music: false, warning: 'audio_unavailable' } };
    expect(await finalizeVideoJob(aiJob())).toMatchObject({ status: 'completed', audioWarning: 'audio_unavailable' });
    expect(state.saved[0].r).toMatchObject({ audio: { warning: 'audio_unavailable' } });

    state.savedWarning = 'audio_partial';
    expect(await finalizeVideoJob(aiJob({ status: 'completed', mediaAssetId: 'asset_1' }))).toMatchObject({ status: 'completed', audioWarning: 'audio_partial' });

    state.assets = []; state.savedWarning = undefined;
    state.motionAiResult = { status: 'done', videoKey: 'users/user_1/motion-ai.mp4', audio: { narration: true, sfx: true, music: false } };
    expect(await finalizeVideoJob(aiJob())).not.toHaveProperty('audioWarning');
  });

  it('settles a footage edit at its real length: asset, row and segments follow it, unused seconds come back', async () => {
    state.motionAiResult = { status: 'done', videoKey: 'users/user_1/edit.mp4', durationSec: 12.4 };
    const r = await finalizeVideoJob(aiJob({ genMode: 'motion-ai-footage', durationSec: 60, creditsCharged: 1080 }));
    expect(r.status).toBe('completed');
    expect(state.assets[0]).toMatchObject({ durationS: '13' });
    expect(state.partials).toEqual([expect.objectContaining({ ledgerId: 'led_1', credits: 1080 - 18 * 13, action: 'video_edit_footage' })]);
    expect(state.job).toMatchObject({ durationSec: 13 });
    expect(state.saved[0].job).toMatchObject({ durationSec: 13 });
    expect(state.refunds).toHaveLength(0);

    // An edit of it that got shorter: the row follows, but edits are priced on what they edit — no refund.
    state.assets = []; state.partials = []; state.saved = [];
    state.motionAiResult = { status: 'done', videoKey: 'users/user_1/edit2.mp4', durationSec: 9.9 };
    await finalizeVideoJob(aiJob({ genMode: 'motion-ai-edit', durationSec: 13, creditsCharged: 117 }));
    expect(state.job).toMatchObject({ durationSec: 10 });
    expect(state.partials).toHaveLength(0);

    // A normal render that reports its exact length changes nothing.
    state.assets = []; state.updates = [];
    state.motionAiResult = { status: 'done', videoKey: 'users/user_1/m.mp4', durationSec: 15 };
    await finalizeVideoJob(aiJob());
    expect(state.assets[0]).toMatchObject({ durationS: '15' });
    expect(state.updates.some((u) => 'durationSec' in u)).toBe(false);
  });

  it('stores no segments for template motion graphics', async () => {
    await finalizeVideoJob(job({ provider: 'motion-hf', providerTaskId: 'm-1', durationSec: 15, genMode: 'motion-stat' }));
    expect(state.saved).toHaveLength(0);
  });

  it('stays pending, touching nothing, when the worker is unconfigured', async () => {
    state.motionAiConfigured = false;
    expect((await finalizeVideoJob(aiJob())).status).toBe('pending');
    expect(state.refunds).toHaveLength(0);
  });
});
