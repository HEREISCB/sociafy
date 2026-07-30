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
  uploads: 0,
  /** How many times the completion ran as one transaction. */
  transactions: 0,
  uploadFails: false,
  r2Stub: false,
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
}));
vi.mock('../env', () => ({ isStubMode: { r2: () => state.r2Stub } }));

import { finalizeVideoJob, type VideoJob } from './finalizeVideoJob';

function job(over: Record<string, unknown> = {}) {
  state.job = {
    id: 'job_1',
    userId: 'user_1',
    status: 'pending',
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
  state.assets = []; state.updates = []; state.refunds = []; state.uploads = 0;
  state.transactions = 0; state.uploadFails = false; state.r2Stub = false;
  state.task = { status: 'completed', videoUrl: 'https://cdn.piapi/x.mp4' };
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

  it('stays pending (no refund, no store) when R2 is unconfigured', async () => {
    state.r2Stub = true;
    const res = await finalizeVideoJob(job());
    expect(res).toEqual({ status: 'pending', pollError: 'r2_not_configured' });
    expect(state.refunds).toHaveLength(0);
    expect(state.uploads).toBe(0);
  });
});
