import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The bug this covers: three production LinkedIn accounts with
 * refresh_token IS NULL, one already expired, and not a single
 * last_refresh_error or activity_log row anywhere. The cron filtered them out
 * of its scan and ensureFreshToken returned before it could stamp anything, so
 * the token just died in silence.
 */

type Row = {
  id: string;
  userId: string;
  platform: string;
  platformUserId: string;
  handle: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  scope: string | null;
  isStub: boolean;
  lastRefreshAt: Date | null;
  lastRefreshError: string | null;
  lastRefreshErrorAt: Date | null;
  updatedAt: Date;
};

const DAY = 86_400_000;

/** The single account under test. One row keeps the drizzle stand-in honest —
 *  every update/insert can only be about this account. */
let row: Row;
let activity: Array<{ kind: string; userId: string; title: string; body: string | null }> = [];
/** Column names drizzle was asked to filter the scan on. */
let scanColumns: string[] = [];

function columnNames(cond: unknown, out: string[] = []): string[] {
  if (!cond || typeof cond !== 'object') return out;
  const c = cond as { name?: unknown; queryChunks?: unknown[] };
  if (typeof c.name === 'string') out.push(c.name);
  if (Array.isArray(c.queryChunks)) for (const chunk of c.queryChunks) columnNames(chunk, out);
  return out;
}

vi.mock('../db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          scanColumns = columnNames(cond);
          // Mirror the real predicate we care about: non-stub, has an expiry,
          // expiry inside the horizon. Deliberately NOT filtered on
          // refreshToken — that filter is what the fix removed.
          const horizon = Date.now() + 15 * DAY;
          const hit = !row.isStub && !!row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= horizon;
          return Promise.resolve(hit ? [{ ...row }] : []);
        },
      }),
    }),
    update: () => ({
      set: (vals: Partial<Row>) => ({
        where: () => Promise.resolve(Object.assign(row, vals)),
      }),
    }),
    insert: () => ({
      values: (v: { kind: string; userId: string; title: string; body: string | null }) => {
        activity.push(v);
        return Promise.resolve();
      },
    }),
  }),
}));

const { runRefreshTokens } = await import('./refreshTokens');

function linkedinRow(expiresInMs: number): Row {
  return {
    id: 'acct-1',
    userId: 'user-1',
    platform: 'linkedin',
    platformUserId: 'li-1',
    handle: 'someone@example.com',
    accessToken: 'plain-access-token',
    refreshToken: null, // LinkedIn never issues one
    tokenExpiresAt: new Date(Date.now() + expiresInMs),
    scope: 'openid profile w_member_social',
    isStub: false,
    lastRefreshAt: null,
    lastRefreshError: null,
    lastRefreshErrorAt: null,
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  activity = [];
  scanColumns = [];
});

describe('runRefreshTokens — accounts that cannot refresh', () => {
  it('scans accounts with no refresh token at all', async () => {
    row = linkedinRow(1 * DAY);
    const out = await runRefreshTokens();
    expect(out.scanned).toBe(1);
    // The filter that hid these rows is gone; the rest of the predicate stays.
    expect(scanColumns).toContain('token_expires_at');
    expect(scanColumns).toContain('is_stub');
    expect(scanColumns).not.toContain('refresh_token');
  });

  it('stamps reconnect_required + one activity row when expiry is near', async () => {
    row = linkedinRow(1 * DAY);
    const out = await runRefreshTokens();

    expect(out.reconnectRequired).toBe(1);
    expect(row.lastRefreshError).toBe('reconnect_required');
    expect(row.lastRefreshErrorAt).toBeInstanceOf(Date);
    expect(activity).toHaveLength(1);
    expect(activity[0].kind).toBe('platform_refresh_failed');
    expect(activity[0].userId).toBe('user-1');
    expect(activity[0].title).toContain('linkedin');
  });

  it('is idempotent — repeated cron runs do not re-log', async () => {
    row = linkedinRow(1 * DAY);
    await runRefreshTokens();
    expect(activity).toHaveLength(1);

    const second = await runRefreshTokens();
    const third = await runRefreshTokens();

    expect(second.reconnectRequired).toBe(0);
    expect(third.reconnectRequired).toBe(0);
    expect(activity).toHaveLength(1);
    expect(row.lastRefreshError).toBe('reconnect_required');
  });

  it('re-arms after the user reconnects and the error is cleared', async () => {
    row = linkedinRow(1 * DAY);
    await runRefreshTokens();
    expect(activity).toHaveLength(1);

    // Reconnect clears the stamp and hands us a fresh token.
    row.lastRefreshError = null;
    row.lastRefreshErrorAt = null;
    row.tokenExpiresAt = new Date(Date.now() + 60 * DAY);
    expect((await runRefreshTokens()).scanned).toBe(0); // outside the horizon
    expect(activity).toHaveLength(1);

    // …and 59 days later it warns again.
    row.tokenExpiresAt = new Date(Date.now() + 2 * DAY);
    expect((await runRefreshTokens()).reconnectRequired).toBe(1);
    expect(activity).toHaveLength(2);
  });

  it('says nothing while the token still has plenty of life', async () => {
    row = linkedinRow(10 * DAY); // inside the 15d scan horizon, outside the 3d warning
    const out = await runRefreshTokens();

    expect(out.scanned).toBe(1);
    expect(out.reconnectRequired).toBe(0);
    expect(row.lastRefreshError).toBeNull();
    expect(activity).toHaveLength(0);
  });

  it('reports an already-expired token as expired', async () => {
    row = linkedinRow(-30 * DAY);
    const out = await runRefreshTokens();

    expect(out.reconnectRequired).toBe(1);
    expect(out.results[0].error).toBe('reconnect_required');
    expect(activity[0].body).toContain('expired');
  });

  it('leaves a refreshable account alone', async () => {
    row = { ...linkedinRow(10 * DAY), platform: 'x', refreshToken: 'a-real-refresh-token' };
    const out = await runRefreshTokens();

    expect(out.reconnectRequired).toBe(0);
    expect(row.lastRefreshError).toBeNull();
    expect(activity).toHaveLength(0);
  });
});
