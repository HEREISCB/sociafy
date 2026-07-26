import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlatformError, type PublishInput, type PublishResult } from '../platforms/types';

// One in-memory scheduled_posts row is enough to exercise the state machine.
type Row = {
  id: string;
  userId: string;
  draftId: string | null;
  accountId: string;
  platform: string;
  status: string;
  text: string;
  media: { url: string; mimeType: string }[];
  attempts: number;
  error: string | null;
  platformPostUrl: string | null;
};

let row: Row;
const activity: Array<{ kind: string }> = [];

/** What the adapter's publishText does on the next call. */
let publish: (input: PublishInput) => Promise<PublishResult>;

/**
 * Minimal drizzle stand-in. runPublish only ever does:
 *   update(scheduledPosts).set(...).where(...).returning()?   → claim / writes
 *   select(...).from(...).where(...)                          → accounts, rollup
 *   insert(activityLog).values(...)                           → feed
 * The table argument is ignored: the single row is the only scheduled post and
 * the only account, so there's nothing to disambiguate.
 */
vi.mock('../db', () => ({
  db: () => ({
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          let applied: Row[] | null = null;
          const apply = () => {
            if (applied) return applied;
            const patch = { ...vals };
            // The claim is the only .set() passing a SQL expression for
            // attempts (`attempts + 1`) — that's how we recognise it, and it
            // only matches rows still 'pending'.
            const isClaim = 'attempts' in patch && typeof patch.attempts !== 'number';
            if (isClaim) {
              delete patch.attempts;
              if (row.status !== 'pending') return (applied = []);
              row.attempts += 1;
            }
            Object.assign(row, patch);
            return (applied = [row]);
          };
          // Awaitable (markFailed / requeue) and .returning()-able (the claim),
          // applying at most once either way.
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
        where: () =>
          Promise.resolve([
            {
              id: row.accountId,
              userId: row.userId,
              platform: row.platform,
              accessToken: 'real-token',
              refreshToken: null,
              platformUserId: 'pu1',
              meta: null,
              isStub: false,
              tokenExpiresAt: null,
              status: row.status, // the draft rollup select reads .status
            },
          ]),
      }),
    }),
    insert: () => ({ values: (v: { kind: string }) => { activity.push(v); return Promise.resolve(); } }),
  }),
}));

vi.mock('../platforms/registry', () => ({
  getAdapter: () => ({ publishText: (input: PublishInput) => publish(input) }),
}));

// ensureFreshToken is exercised in its own right elsewhere; here it's a pass-through.
vi.mock('../platforms/token', () => ({
  ensureFreshToken: (a: unknown) => Promise.resolve(a),
}));

import { runPublish, isPermanent } from './publish';

function seed(overrides: Partial<Row> = {}) {
  row = {
    id: 'sp1',
    userId: 'u1',
    draftId: null,
    accountId: 'acc1',
    platform: 'x',
    status: 'pending',
    text: 'hello',
    media: [],
    attempts: 0,
    error: null,
    platformPostUrl: null,
    ...overrides,
  };
  activity.length = 0;
}

describe('runPublish — stub publishes are not successes', () => {
  beforeEach(() => seed());

  it('records a stub publish as failed, not published', async () => {
    publish = async () => ({
      platformPostId: 'stub-x-1',
      url: 'https://stub.sociafy.local/x/stub-x-1',
      stub: true,
    });

    const out = await runPublish();

    expect(out.results[0].ok).toBe(false);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/platform_not_connected/);
    // No dead stub link left on the row for the UI to render as a permalink.
    expect(row.platformPostUrl).toBeNull();
  });

  it('does not retry a stub publish — connecting an account is the only fix', async () => {
    publish = async () => ({ platformPostId: 'stub-x-1', url: null, stub: true });
    const out = await runPublish();
    expect(out.results[0].willRetry).toBe(false);
    expect(row.status).toBe('failed');
  });

  it('still records a real publish as published', async () => {
    publish = async () => ({ platformPostId: '123', url: 'https://x.com/i/web/status/123' });
    const out = await runPublish();
    expect(out.results[0].ok).toBe(true);
    expect(row.status).toBe('published');
    expect(row.platformPostUrl).toBe('https://x.com/i/web/status/123');
  });
});

describe('runPublish — retry state machine', () => {
  beforeEach(() => seed());

  it('requeues a transient failure as pending so a later tick retries', async () => {
    publish = async () => { throw new PlatformError('x_publish_failed', 503, 'upstream down'); };

    const out = await runPublish();

    expect(out.results[0].willRetry).toBe(true);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.error).toMatch(/retrying \(1\/3\)/);
    // Terminal-only activity logging: no feed spam per attempt.
    expect(activity.filter((a) => a.kind === 'publish_failed')).toHaveLength(0);
  });

  it('goes terminal on the third attempt and logs it once', async () => {
    publish = async () => { throw new PlatformError('x_publish_failed', 429, 'slow down'); };

    await runPublish();
    expect(row.status).toBe('pending');
    await runPublish();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(2);
    await runPublish();

    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
    expect(activity.filter((a) => a.kind === 'publish_failed')).toHaveLength(1);
  });

  it('succeeding on a retry publishes and clears the failure', async () => {
    publish = async () => { throw new PlatformError('x_publish_failed', 500, 'boom'); };
    await runPublish();
    expect(row.status).toBe('pending');

    publish = async () => ({ platformPostId: '456', url: 'https://x.com/i/web/status/456' });
    const out = await runPublish();

    expect(out.results[0].ok).toBe(true);
    expect(row.status).toBe('published');
    expect(row.attempts).toBe(2);
  });

  it('fails a permanent error immediately without burning attempts', async () => {
    publish = async () => {
      throw new PlatformError('instagram_requires_media', 400, 'attach media first');
    };

    const out = await runPublish();

    expect(out.results[0].willRetry).toBe(false);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    // The upstream detail makes it into the message the user sees.
    expect(row.error).toMatch(/attach media first/);
  });

  it('claims nothing when the row is not pending', async () => {
    seed({ status: 'published' });
    publish = async () => { throw new Error('should not be called'); };
    const out = await runPublish();
    expect(out.ran).toBe(0);
  });
});

describe('isPermanent', () => {
  it('treats 4xx as permanent except 408 and 429', () => {
    expect(isPermanent(new PlatformError('revoked', 401))).toBe(true);
    expect(isPermanent(new PlatformError('bad content', 422))).toBe(true);
    expect(isPermanent(new PlatformError('timeout', 408))).toBe(false);
    expect(isPermanent(new PlatformError('rate limited', 429))).toBe(false);
  });

  it('treats 5xx and plain errors as transient', () => {
    expect(isPermanent(new PlatformError('bad gateway', 502))).toBe(false);
    expect(isPermanent(new TypeError('fetch failed'))).toBe(false);
  });
});
