import { describe, expect, it } from 'vitest';
import { accountStatus, span } from './account-status';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const DAY = 86_400_000;
const base = { platform: 'linkedin', isStub: false, autoRefresh: false, lastRefreshError: null };

describe('accountStatus', () => {
  it('flags an expired token as broken and says what is stuck', () => {
    const s = accountStatus({ ...base, tokenExpiresAt: at(-2 * DAY) }, NOW, 2);
    expect(s).toMatchObject({ rank: 0, tone: 'bad', broken: true });
    expect(s.line).toBe('Expired 2 days ago · 2 queued posts won’t publish until you reconnect');
  });

  it('a refresh error is broken even before expiry', () => {
    const s = accountStatus({ ...base, tokenExpiresAt: at(DAY * 30), lastRefreshError: 'reconnect_required' }, NOW, 0);
    expect(s.broken).toBe(true);
    expect(s.line).toContain('LinkedIn can’t renew access on its own');
    expect(s.line).toContain('Reconnect to resume posting');
  });

  it('a non-renewing token inside a week is "soon", not broken', () => {
    const s = accountStatus({ ...base, tokenExpiresAt: at(3 * DAY + 3600_000) }, NOW);
    expect(s).toMatchObject({ rank: 1, tone: 'warn', broken: false, soon: true, badge: 'Reconnect in 3 days' });
  });

  it('auto-renewing and long-lived tokens are healthy', () => {
    expect(accountStatus({ ...base, autoRefresh: true, tokenExpiresAt: at(2 * DAY) }, NOW)).toMatchObject({ rank: 4, broken: false, soon: false });
    expect(accountStatus({ ...base, tokenExpiresAt: null }, NOW).line).toBe('Access doesn’t expire');
  });

  it('a demo account needs connecting for real', () => {
    expect(accountStatus({ ...base, isStub: true, tokenExpiresAt: null }, NOW)).toMatchObject({ rank: 2, broken: true });
  });

  it('sorts attention first', () => {
    const rows = [
      accountStatus({ ...base, tokenExpiresAt: null }, NOW),
      accountStatus({ ...base, tokenExpiresAt: at(-1) }, NOW),
      accountStatus({ ...base, tokenExpiresAt: at(DAY) }, NOW),
    ].sort((a, b) => a.rank - b.rank);
    expect(rows.map((r) => r.rank)).toEqual([0, 1, 4]);
  });
});

describe('span', () => {
  it('formats days, hours and minutes', () => {
    expect(span(DAY)).toBe('1 day');
    expect(span(5 * 3600_000 + 10)).toBe('5 h');
    expect(span(10)).toBe('1 min');
  });
});
