'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon, Pglyph } from './icons';
import { useApi } from '../lib/ui/fetcher';
import { healthFor, type Health } from '../lib/ui/health';
import { PLATFORMS, PLATFORM_LABELS, oauthErrorCopy, oauthErrorRetryable } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';

export type Account = {
  id: string;
  platform: Platform;
  platformUserId: string;
  handle: string | null;
  displayName: string | null;
  isStub: boolean;
  tokenExpiresAt: string | null;
  autoRefresh: boolean;
  lastRefreshError: string | null;
  createdAt: string;
  meta: { pageName?: string } | null;
};

export type Flash =
  | { kind: 'success'; platform: string; handle: string | null }
  | { kind: 'error'; platform: string; detail: string };

/** Can this account publish right now? */
export const isHealthy = (h: Health) => h.status === 'live' || h.status === 'persistent' || h.status === 'expiring';

/** A ticking "now" so token-expiry math stays pure during render. */
export function useNow(): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    queueMicrotask(() => setNow(Date.now()));
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Reads the OAuth callback params (?connected, ?handle, ?oauth_error,
 * ?platform) once on mount and strips them (plus the legacy ?tab) so a reload
 * can't replay the banner. `onRead(fromOAuth)` fires once either way. A
 * success banner auto-dismisses after 5s; errors stay until dismissed.
 */
export function useOAuthReturn(onRead?: (fromOAuth: boolean) => void) {
  const [flash, setFlash] = useState<Flash | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const detail = params.get('oauth_error');
    const platform = params.get('platform') ?? connected ?? 'platform';
    const handle = params.get('handle');
    const fromOAuth = !!(connected || detail);
    if (fromOAuth) {
      for (const k of ['connected', 'handle', 'oauth_error', 'platform', 'tab']) params.delete(k);
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
    queueMicrotask(() => {
      if (connected) setFlash({ kind: 'success', platform: connected, handle });
      else if (detail) setFlash({ kind: 'error', platform, detail });
      onRead?.(fromOAuth);
    });
    // Mount-only by design: the params are consumed on first read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (flash?.kind !== 'success') return;
    const t = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);
  return { flash, dismiss: () => setFlash(null) };
}

export const handleOf = (a: Pick<Account, 'handle' | 'displayName' | 'platformUserId'>) =>
  a.handle ? `@${a.handle.replace(/^@/, '')}` : a.displayName || a.platformUserId;

const badgeTone: Record<Health['tone'], string> = {
  good: 'badge--ok',
  accent: 'badge--ok',
  warn: 'badge--warn',
  bad: 'badge--err',
  neutral: '',
};

/**
 * Onboarding's connect list: PLATFORMS order, one action per row.
 * Settings › Accounts has its own list in connections.tsx.
 */
export default function ConnectionsList({
  next,
  flash,
  onDismissFlash,
}: {
  mode: 'onboarding';
  /** Where OAuth returns to. */
  next: string;
  flash: Flash | null;
  onDismissFlash: () => void;
}) {
  const { data: accounts, mutate, unauth } = useApi<Account[]>('/api/accounts');
  const now = useNow();
  // Back from OAuth: refetch, and show that row as "Connecting…" until the
  // refetch lands, so the list never contradicts the "X connected" banner.
  const [arriving, setArriving] = useState<string | null>(null);
  const arrived = flash?.kind === 'success' ? flash.platform : null;
  useEffect(() => {
    if (!arrived) return;
    queueMicrotask(() => setArriving(arrived));
    mutate().finally(() => setArriving(null));
  }, [arrived, mutate]);

  const connect = (p: Platform) => window.location.assign(`/api/oauth/${p}/start?next=${encodeURIComponent(next)}`);

  return (
    <div className="stack">
      {flash && <FlashBanner flash={flash} onDismiss={onDismissFlash} onRetry={() => { onDismissFlash(); connect(flash.platform as Platform); }} />}

      {unauth && (
        <div className="conn-banner">
          <span className="conn-banner__text">Sign in to connect accounts.</span>
          <Link className="btn sm" href={`/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>
        </div>
      )}

      <ul className="conn-list">
        {PLATFORMS.map((p) => {
          const acct = accounts?.find((a) => a.platform === p.id) ?? null;
          const health = healthFor(acct, now);
          const healthy = isHealthy(health);
          return (
            <li key={p.id} className="conn-row">
              <div className="conn-row__main">
                <Pglyph p={p.short} size="lg" />
                <div className="conn-row__meta">
                  <div className="conn-row__name">
                    {p.name}
                    {acct && <span className={`badge ${badgeTone[health.tone]}`}>{health.label}</span>}
                  </div>
                  <div className="conn-row__sub">{acct && healthy ? handleOf(acct) : p.tip}</div>
                </div>
                <div className="conn-row__actions">
                  {!healthy && arriving === p.id ? (
                    <span className="conn-row__done is-pending" role="status">Connecting…</span>
                  ) : healthy ? (
                    <span className="conn-row__done"><Icon name="check" size={12} /> Connected</span>
                  ) : (
                    <button type="button" className="btn sm" onClick={() => connect(p.id)} disabled={!!unauth}>
                      {acct ? 'Reconnect' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FlashBanner({ flash, onDismiss, onRetry }: { flash: Flash; onDismiss: () => void; onRetry: () => void }) {
  const ok = flash.kind === 'success';
  const label = PLATFORM_LABELS[flash.platform] ?? flash.platform;
  return (
    <div role={ok ? 'status' : 'alert'} className={`conn-banner ${ok ? 'conn-banner--ok' : 'conn-banner--err'}`}>
      <span className="conn-banner__text">
        <strong>{ok ? `${label} connected` : `Couldn't connect ${label}`}</strong>{' '}
        {ok
          ? flash.handle ? `as @${flash.handle.replace(/^@/, '')}.` : ''
          : oauthErrorCopy(flash.detail, flash.platform)}
      </span>
      {!ok && oauthErrorRetryable(flash.detail) && (
        <button type="button" className="btn sm" onClick={onRetry}>Retry</button>
      )}
      <button type="button" className="btn ghost sm" onClick={onDismiss} aria-label="Dismiss">
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
