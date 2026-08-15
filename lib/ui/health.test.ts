import { describe, it, expect } from 'vitest';
import { healthFor } from './health';
import { activityMeta } from './activity';

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const DAY = 86_400_000;

function acct(over: Partial<Parameters<typeof healthFor>[0]> = {}) {
  return { isStub: false, tokenExpiresAt: null, autoRefresh: false, lastRefreshError: null, ...over };
}

describe('healthFor', () => {
  it('reports a dead connection as needing a reconnect, not as live', () => {
    // The dashboard used to paint this account green while Connections showed
    // it red. Both now read the same field.
    const h = healthFor(acct({ lastRefreshError: 'reconnect_required', tokenExpiresAt: new Date(NOW + 30 * DAY).toISOString() }), NOW);
    expect(h.status).toBe('expired');
    expect(h.label).toBe('Reconnect needed');
    expect(h.tone).toBe('bad');
  });

  it('distinguishes "cannot renew" from "a refresh attempt failed"', () => {
    expect(healthFor(acct({ lastRefreshError: 'reconnect_required' }), NOW).detail).toContain('auto-renew');
    expect(healthFor(acct({ lastRefreshError: '401 invalid_grant' }), NOW).detail).toBe('last refresh failed');
  });

  it('flags an expired token even with no stamped error', () => {
    const h = healthFor(acct({ tokenExpiresAt: new Date(NOW - DAY).toISOString() }), NOW);
    expect(h.status).toBe('expired');
    expect(h.tone).toBe('bad');
  });

  it('warns inside the last day', () => {
    const h = healthFor(acct({ tokenExpiresAt: new Date(NOW + 3 * 3_600_000).toISOString() }), NOW);
    expect(h.status).toBe('expiring');
    expect(h.tone).toBe('warn');
    expect(h.detail).toBe('expires in 3h 0m');
  });

  it('calls a healthy token connected, and an auto-renewing one calm', () => {
    expect(healthFor(acct({ tokenExpiresAt: new Date(NOW + 30 * DAY).toISOString() }), NOW).status).toBe('live');
    expect(healthFor(acct({ tokenExpiresAt: new Date(NOW + 30 * DAY).toISOString(), autoRefresh: true }), NOW).label).toBe('Auto-renewing');
    expect(healthFor(acct({ tokenExpiresAt: null }), NOW).status).toBe('persistent');
  });

  it('marks stubs and missing accounts', () => {
    expect(healthFor(acct({ isStub: true }), NOW).status).toBe('stub');
    expect(healthFor(null, NOW).status).toBe('offline');
  });

  it('ranks the error stamp above a still-valid expiry date', () => {
    // Token has 30 days left on paper but the platform already rejected it.
    const h = healthFor(acct({ tokenExpiresAt: new Date(NOW + 30 * DAY).toISOString(), lastRefreshError: 'boom', autoRefresh: true }), NOW);
    expect(h.label).toBe('Reconnect needed');
  });
});

describe('activityMeta', () => {
  it('labels a dead connection as a warning instead of leaking the raw kind', () => {
    const m = activityMeta('platform_refresh_failed');
    expect(m.label).toBe('Reconnect needed');
    expect(m.tone).toBe('warn');
  });

  it('warns on the other bad-news kinds', () => {
    expect(activityMeta('publish_failed').tone).toBe('warn');
    expect(activityMeta('agent_held').tone).toBe('warn');
    expect(activityMeta('agent_skipped').tone).toBe('warn');
  });

  it('never shows a snake_case machine string for an unmapped kind', () => {
    expect(activityMeta('some_new_kind').label).toBe('Some new kind');
  });
});
