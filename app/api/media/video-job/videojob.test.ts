import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The dashboard poller is the only thing standing between video_jobs.error —
 * which embeds the provider's name and a slice of its response body — and the
 * browser. Production stored `piapi_failed: Your content violated community
 * guidelines.` for two real jobs and the UI called it a timeout, telling the
 * user to retry at 720p: another ~90 credits on a generation that fails
 * identically.
 */

const state = vi.hoisted(() => ({
  job: { id: 'job_1', userId: 'user_1' } as Record<string, unknown>,
  result: { status: 'pending' } as Record<string, unknown>,
}));

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));

vi.mock('../../../../lib/db', () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([state.job]) }) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (_c: unknown, v: unknown) => v,
  ne: () => true,
  and: (...cs: unknown[]) => cs,
  notInArray: () => true,
  sql: () => ({}),
}));
vi.mock('../../../../lib/db/schema', () => ({
  videoJobs: { id: 'id', userId: 'userId' },
  mediaAssets: { id: 'id' },
  creditLedger: { id: 'id' },
  genJobs: { id: 'id' },
}));
vi.mock('../../../../lib/env', () => ({ isStubMode: { r2: () => false, database: () => false } }));
vi.mock('../../../../lib/media/finalizeVideoJob', () => ({
  finalizeVideoJob: () => Promise.resolve(state.result),
}));

import { GET } from './[jobId]/route';

const poll = () =>
  GET({} as never, { params: Promise.resolve({ jobId: 'job_1' }) }) as unknown as Promise<Record<string, unknown>>;

beforeEach(() => {
  process.env.PIAPI_API_KEY = 'k';
  state.job = { id: 'job_1', userId: 'user_1' };
  state.result = { status: 'pending' };
});

describe('GET /api/media/video-job/[jobId]', () => {
  it('reports a content refusal as prompt_rejected, with no provider text', async () => {
    state.result = { status: 'failed', error: 'piapi_failed: Your content violated community guidelines.' };
    const res = await poll();
    expect(res).toEqual({ status: 'failed', error: 'prompt_rejected' });
    const wire = JSON.stringify(res);
    for (const leak of ['piapi', 'community guidelines', 'violated']) {
      expect(wire.toLowerCase()).not.toContain(leak);
    }
  });

  it('keeps a stuck job distinct from a refused one', async () => {
    state.result = { status: 'failed', error: 'provider_stuck' };
    expect(await poll()).toEqual({ status: 'failed', error: 'generation_timeout' });
  });

  it('maps the remaining internal reasons to their public codes', async () => {
    for (const [raw, code] of [
      ['store_failed: 500 from r2', 'storage_failed'],
      ['submit_unconfirmed: socket hang up', 'submit_unconfirmed'],
      ['duplicate_request', 'duplicate_request'],
      ['piapi_failed: model exploded', 'generation_failed'],
      [null, 'generation_failed'],
    ] as const) {
      state.result = { status: 'failed', error: raw };
      expect(await poll()).toEqual({ status: 'failed', error: code });
    }
  });

  it('passes a pending or completed result through untouched', async () => {
    state.result = { status: 'pending', providerStatus: 'processing' };
    expect(await poll()).toEqual({ status: 'pending', providerStatus: 'processing' });
    state.result = { status: 'completed', asset: { id: 'a1' } };
    expect(await poll()).toEqual({ status: 'completed', asset: { id: 'a1' } });
  });
});

/**
 * The code is only half the fix — the copy the user reads is the other half, and
 * it lives in a client component no node-environment test can render. Assert the
 * source instead: the blanket timeout line must be gone, and a refusal must say
 * retrying unchanged will not help.
 */
describe('components/compose.tsx renders the reason, not a guess', () => {
  const src = fs.readFileSync(
    path.join(path.resolve(__dirname, '../../../..'), 'components/compose.tsx'),
    'utf8',
  );

  it('no longer blames capacity for every failure', () => {
    expect(src).not.toContain('Video generation timed out or failed. Try a shorter clip or 720p.');
  });

  it('tells a rejected prompt to be reworded, not retried', () => {
    const copy = src.match(/prompt_rejected: '([^']+)'/)?.[1] ?? '';
    expect(copy).toMatch(/reword/i);
    expect(copy).toMatch(/refused again|will not help|fail/i);
    expect(copy.toLowerCase()).not.toContain('piapi');
  });

  it('keeps "we stopped polling" separate from "the provider failed it"', () => {
    expect(src).toContain('poll_timeout');
    expect(src.match(/poll_timeout: '([^']+)'/)?.[1] ?? '').toMatch(/still rendering/i);
  });
});
