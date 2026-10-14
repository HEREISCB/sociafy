'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon, Pglyph } from './icons';
import { apiDelete, useApi } from '../lib/ui/fetcher';
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

type ScheduledPost = {
  platform: Platform;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';
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

const handleOf = (a: Account) => (a.handle ? `@${a.handle.replace(/^@/, '')}` : a.displayName || a.platformUserId);

const badgeTone: Record<Health['tone'], string> = {
  good: 'badge--ok',
  accent: 'badge--ok',
  warn: 'badge--warn',
  bad: 'badge--err',
  neutral: '',
};

export default function ConnectionsList({
  mode,
  next,
  flash,
  onDismissFlash,
}: {
  mode: 'onboarding' | 'manage';
  /** Where OAuth returns to. */
  next: string;
  flash: Flash | null;
  onDismissFlash: () => void;
}) {
  const manage = mode === 'manage';
  const { data: accounts, mutate, unauth } = useApi<Account[]>('/api/accounts');
  const { data: scheduled } = useApi<ScheduledPost[]>(manage ? '/api/schedule' : null);
  const now = useNow();
  const [open, setOpen] = useState<Platform | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
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

  const disconnect = async (a: Account) => {
    setBusy(a.id);
    setDisconnectError(null);
    try {
      await apiDelete(`/api/accounts/${a.id}`);
      await mutate();
      setConfirming(null);
      setOpen(null);
    } catch {
      setDisconnectError(`Couldn't disconnect ${PLATFORM_LABELS[a.platform] ?? a.platform}. Please try again.`);
    } finally {
      setBusy(null);
    }
  };

  const count = (p: Platform, statuses: ScheduledPost['status'][]) =>
    (scheduled ?? []).filter((s) => s.platform === p && statuses.includes(s.status)).length;

  return (
    <div className="stack">
      {flash && <FlashBanner flash={flash} onDismiss={onDismissFlash} onRetry={() => { onDismissFlash(); connect(flash.platform as Platform); }} />}

      {disconnectError && (
        <div role="alert" className="conn-banner conn-banner--err">
          <span className="conn-banner__text">{disconnectError}</span>
          <button type="button" className="btn ghost sm" onClick={() => setDisconnectError(null)} aria-label="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

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
          const expanded = manage && open === p.id && !!acct;
          const queued = count(p.id, ['pending', 'publishing']);
          const published = count(p.id, ['published']);
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
                  ) : healthy && !manage ? (
                    <span className="conn-row__done"><Icon name="check" size={12} /> Connected</span>
                  ) : !healthy ? (
                    <button type="button" className="btn sm" onClick={() => connect(p.id)} disabled={!!unauth}>
                      {acct ? 'Reconnect' : 'Connect'}
                    </button>
                  ) : null}
                  {manage && acct && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      aria-expanded={expanded}
                      aria-label={`${p.name} details`}
                      onClick={() => { setOpen(expanded ? null : p.id); setConfirming(null); }}
                    >
                      <Icon name={expanded ? 'chevron_down' : 'chevron_right'} size={12} />
                    </button>
                  )}
                </div>
              </div>

              {expanded && acct && (
                <div className="conn-row__details">
                  <dl className="conn-facts">
                    <dt>Account</dt>
                    <dd>{handleOf(acct)}{acct.meta?.pageName ? ` · ${acct.meta.pageName}` : ''}</dd>
                    <dt>Access</dt>
                    <dd>{health.status === 'persistent' ? 'Does not expire' : health.detail}</dd>
                    <dt>Connected</dt>
                    <dd>{new Date(acct.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</dd>
                  </dl>
                  {confirming === acct.id ? (
                    <div className="stack">
                      {/* Disconnecting deletes this platform's queue and publish history; drafts survive. */}
                      <p className="conn-warn">
                        <strong>
                          This permanently deletes {queued > 0 ? `${queued} queued post${queued === 1 ? '' : 's'}` : 'nothing from your queue'}
                          {published > 0 ? ` and ${published} published post${published === 1 ? '' : 's'} from your ${p.name} history` : ''}.
                        </strong>{' '}
                        {queued > 0 ? 'Those posts will never publish. ' : ''}Your drafts are kept.
                      </p>
                      <div className="row">
                        <button type="button" className="btn sm" onClick={() => setConfirming(null)} disabled={busy === acct.id}>Cancel</button>
                        <button type="button" className="btn sm conn-danger" onClick={() => disconnect(acct)} disabled={busy === acct.id}>
                          {busy === acct.id ? 'Removing…' : `Disconnect ${p.name}`}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="row">
                      {healthy && (
                        <button type="button" className="btn sm" onClick={() => connect(p.id)} disabled={!!unauth}>Reconnect</button>
                      )}
                      <button type="button" className="btn ghost sm conn-danger-text" onClick={() => setConfirming(acct.id)} disabled={!!unauth}>
                        Disconnect
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FlashBanner({ flash, onDismiss, onRetry }: { flash: Flash; onDismiss: () => void; onRetry: () => void }) {
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
