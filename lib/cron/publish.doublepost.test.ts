/**
 * REGRESSION — a post that went live must never be published twice.
 *
 * Was: the try in runPublish spanned both the platform call and the
 * bookkeeping after it, so either
 *   1. adapter.publishText resolving at the platform while the HTTP response
 *      is lost (socket hangup / timeout) -> a non-PlatformError throw, or
 *   2. the bookkeeping after a confirmed success throwing (the activity_log
 *      insert, or the status update itself)
 * routed to fail(), which flipped the row back to 'pending' — and the next
 * 5-minute tick reclaimed it and posted the same text to the customer's real
 * account a second time. No adapter sends an idempotency key.
 *
 * Now: the try wraps publishText only; a throw with no HTTP status is treated
 * as unconfirmed and goes terminal, and post-success bookkeeping failures are
 * swallowed + logged, leaving the row out of the queue for good.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlatformError, type PublishInput, type PublishResult } from '../platforms/types';

type Row = {
  id: string; userId: string; draftId: string | null; accountId: string;
  platform: string; status: string; text: string;
  media: { url: string; mimeType: string }[];
  attempts: number; error: string | null; platformPostUrl: string | null;
};

let row: Row;
let publish: (input: PublishInput) => Promise<PublishResult>;
/** Set to make the activity_log insert blow up once (a DB blip). */
let insertThrowsOnce = false;
/** Every text actually handed to the platform. Length > 1 == double post. */
const sentToPlatform: string[] = [];

vi.mock('../db', () => ({
  db: () => ({
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          let applied: Row[] | null = null;
          const apply = () => {
            if (applied) return applied;
            const patch = { ...vals };
            const isClaim = 'attempts' in patch && typeof patch.attempts !== 'number';
            if (isClaim) {
              delete patch.attempts;
              if (row.status !== 'pending') return (applied = []);
              row.attempts += 1;
            }
            Object.assign(row, patch);
            return (applied = [row]);
          };
          return {
            then: (res: (r: Row[]) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(apply()).then(res, rej),
            returning: () => Promise.resolve(apply()),
          };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{
          id: row.accountId, userId: row.userId, platform: row.platform,
          accessToken: 'real-token', refreshToken: null, platformUserId: 'pu1',
          meta: null, isStub: false, tokenExpiresAt: null, status: row.status,
        }]),
      }),
    }),
    insert: () => ({
      values: () => {
        if (insertThrowsOnce) {
          insertThrowsOnce = false;
          return Promise.reject(new Error('connection terminated unexpectedly'));
        }
        return Promise.resolve();
      },
    }),
  }),
}));

vi.mock('../platforms/registry', () => ({
  getAdapter: () => ({ publishText: (input: PublishInput) => publish(input) }),
}));
vi.mock('../platforms/token', () => ({
  ensureFreshToken: (a: unknown) => Promise.resolve(a),
}));

import { runPublish } from './publish';

beforeEach(() => {
  row = {
    id: 'sp1', userId: 'u1', draftId: null, accountId: 'acc1', platform: 'x',
    status: 'pending', text: 'ship it', media: [], attempts: 0,
    error: null, platformPostUrl: null,
  };
  sentToPlatform.length = 0;
  insertThrowsOnce = false;
});

describe('a live post is never republished', () => {
  it('a bookkeeping error after a confirmed publish leaves the row terminal', async () => {
    publish = async (input) => {
      sentToPlatform.push(input.text);
      return { platformPostId: `id-${sentToPlatform.length}`, url: 'https://x.com/i/web/status/1' };
    };

    insertThrowsOnce = true; // activity_log insert fails right after success
    await runPublish();

    // The tweet is live and the row says so — a lost log line does not undo it.
    expect(sentToPlatform).toHaveLength(1);
    expect(row.status).toBe('published');

    // Next cron tick (5 min later) has nothing to claim.
    await runPublish();
    expect(sentToPlatform).toEqual(['ship it']);
  });

  it('a lost response after the platform accepted the post is not retried', async () => {
    publish = async (input) => {
      sentToPlatform.push(input.text);
      // Tweet created; the response never made it back to us. We got no HTTP
      // status, so we cannot know — and must not gamble the customer's feed.
      throw new TypeError('fetch failed');
    };

    await runPublish();
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/publish_unconfirmed/);

    await runPublish();
    expect(sentToPlatform).toEqual(['ship it']); // no second post
  });

  it('still retries when the platform actually answered with a transient error', async () => {
    // A PlatformError carries an HTTP status: the platform said no, nothing
    // was posted, retrying is safe. That path must keep working.
    publish = async () => { throw new PlatformError('x_publish_failed', 503, 'bad gateway'); };
    await runPublish();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);

    publish = async (input) => {
      sentToPlatform.push(input.text);
      return { platformPostId: 'id-1', url: 'https://x.com/i/web/status/1' };
    };
    await runPublish();
    expect(row.status).toBe('published');
    expect(sentToPlatform).toEqual(['ship it']);
  });

  it('goes terminal after MAX_ATTEMPTS transient failures', async () => {
    publish = async () => { throw new PlatformError('x_publish_failed', 503, 'bad gateway'); };
    await runPublish();
    await runPublish();
    await runPublish();
    expect(row.attempts).toBe(3);
    expect(row.status).toBe('failed');
  });
});
