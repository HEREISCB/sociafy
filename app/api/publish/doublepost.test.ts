/**
 * REGRESSION — "Post now" must never report a live post as failed.
 *
 * Was: one try in POST /api/publish spanned both adapter.publishText and the
 * bookkeeping after it (the scheduled_posts status update, the activity_log
 * insert). So a dropped DB connection *after* the platform accepted the post
 * fell into the catch, marked the row 'failed' and returned an error — and
 * the user clicked "Post now" again, putting the same text on their real
 * account twice. No adapter sends an idempotency key.
 *
 * Now: the try wraps publishText only. Post-publish bookkeeping is swallowed
 * and logged (`PUBLISHED BUT NOT RECORDED`), and a throw with no HTTP status
 * is reported as publish_unconfirmed instead of inviting a re-click.
 *
 * Mirrors lib/cron/publish.doublepost.test.ts for the manual path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { PlatformError, type PublishInput, type PublishResult } from '../../../lib/platforms/types';

type Rec = Record<string, unknown>;

const state = {
  selects: [] as Rec[][],
  updates: [] as Rec[],
  inserts: [] as Rec[],
  /** Make the post-publish bookkeeping blow up, as a DB blip would. */
  throwOn: new Set<'publishedUpdate' | 'activityInsert'>(),
};

/** Every text actually handed to the platform. Length > 1 == double post. */
const sentToPlatform: string[] = [];

const thenable = <T>(value: T, extra: Rec = {}) => Object.assign(Promise.resolve(value), extra);

vi.mock('../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: () => {
        const rows = state.selects.shift() ?? [];
        return { where: () => thenable(rows, { limit: () => Promise.resolve(rows) }) };
      },
    }),
    update: () => ({
      set: (set: Rec) => {
        state.updates.push(set);
        // The scheduled_posts row going green — not the drafts rollup, which
        // carries no platformPostId.
        if (set.status === 'published' && 'platformPostId' in set && state.throwOn.has('publishedUpdate')) {
          return { where: () => Promise.reject(new Error('connection terminated unexpectedly')) };
        }
        return { where: () => Promise.resolve([]) };
      },
    }),
    insert: () => ({
      values: (values: Rec) => {
        state.inserts.push(values);
        if (values.kind === 'manual_publish' && state.throwOn.has('activityInsert')) {
          return Promise.reject(new Error('connection terminated unexpectedly'));
        }
        const row = [{ ...values, id: 'sp-1' }];
        return thenable(row, { returning: () => Promise.resolve(row) });
      },
    }),
  }),
}));

vi.mock('../../../lib/api', () => ({
  jsonError: (message: string, status = 400, extra?: Rec) =>
    NextResponse.json({ error: message, ...extra }, { status }),
  withUser: async (handler: (u: { id: string }) => unknown) => {
    const result = await handler({ id: 'u1' });
    return result instanceof Response ? result : NextResponse.json(result);
  },
}));

let publish: (input: PublishInput) => Promise<PublishResult>;
vi.mock('../../../lib/platforms/registry', () => ({
  getAdapter: () => ({ publishText: (input: PublishInput) => publish(input) }),
}));
vi.mock('../../../lib/platforms/token', () => ({
  ensureFreshToken: async (a: Rec) => a,
}));

import { POST } from './route';

const DRAFT = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u1',
  body: 'ship it',
  targetPlatforms: ['x'],
  perPlatformText: null,
  media: [],
};

const ACCOUNT = {
  id: 'a1', userId: 'u1', platform: 'x', accessToken: 'real', refreshToken: null,
  platformUserId: 'p1', meta: null, isStub: false, tokenExpiresAt: null, lastRefreshError: null,
};

const post = () =>
  POST({ json: async () => ({ draftId: DRAFT.id, platforms: ['x'] }) } as unknown as NextRequest);

const statuses = () => state.updates.map((u) => u.status);

beforeEach(() => {
  state.selects = [[DRAFT], [ACCOUNT]];
  state.updates = [];
  state.inserts = [];
  state.throwOn.clear();
  sentToPlatform.length = 0;
  publish = async (input) => {
    sentToPlatform.push(input.text);
    return { platformPostId: `id-${sentToPlatform.length}`, url: 'https://x.com/i/web/status/1' };
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/publish — a live post is never reported as failed', () => {
  it('swallows a status-update failure after a confirmed publish', async () => {
    state.throwOn.add('publishedUpdate');

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0]).toMatchObject({ ok: true, url: 'https://x.com/i/web/status/1' });
    // The row never goes 'failed' — that's what makes the user click again.
    expect(statuses()).not.toContain('failed');
    expect(sentToPlatform).toEqual(['ship it']);
    // Logged loudly so a human can reconcile the stranded row.
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('PUBLISHED BUT NOT RECORDED');
  });

  it('swallows an activity-log failure after a confirmed publish', async () => {
    state.throwOn.add('activityInsert');

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].ok).toBe(true);
    expect(statuses()).toContain('published');
    expect(statuses()).not.toContain('failed');
  });

  it('reports a lost response as unconfirmed instead of inviting a retry', async () => {
    publish = async (input) => {
      sentToPlatform.push(input.text);
      // Post created; the response never made it back. No HTTP status means
      // no verdict — re-clicking "Post now" is a coin flip on a duplicate.
      throw new TypeError('fetch failed');
    };

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(String(body.error)).toMatch(/^publish_unconfirmed/);
    expect(String(body.error)).toContain('may or may not be live');
    expect(body.results[0].ok).toBe(false);
    expect(statuses()).toContain('failed');
    expect(statuses()).not.toContain('published');
  });

  it('still fails on a genuine platform rejection', async () => {
    publish = async () => { throw new PlatformError('x_publish_failed', 403, 'not authorized'); };

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain('x_publish_failed');
    expect(body.error).toContain('(403)');
    expect(body.error).toContain('not authorized');
    expect(body.error).not.toContain('publish_unconfirmed');
    expect(statuses()).toContain('failed');
    expect(state.inserts.some((i) => i.kind === 'publish_failed')).toBe(true);
  });

  it('still fails on a simulated (stub) publish', async () => {
    publish = async () => ({
      platformPostId: 'stub-x-1',
      url: 'https://stub.sociafy.local/x/stub-x-1',
      stub: true,
    });

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(String(body.error)).toContain('platform_not_connected');
    expect(statuses()).toContain('failed');
    expect(statuses()).not.toContain('published');
    expect(JSON.stringify(body)).not.toContain('stub.sociafy.local');
  });
});
