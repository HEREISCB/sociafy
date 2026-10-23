'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon, Pglyph } from './icons';
import { apiDelete, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { PLATFORMS, type PlatformMeta } from '../lib/ui/platforms';
import { accountStatus, type AccountStatus } from '../lib/ui/account-status';
import type { Platform } from '../lib/db/schema';
import { FlashBanner, handleOf, useNow, useOAuthReturn, type Account } from './connections-list';
import { PageHeader, useToast } from './ui';

type Scheduled = { platform: Platform; status: 'pending' | 'publishing' | 'published' | 'failed' | 'canceled'; scheduledAt: string };
type Agent = { enabled: boolean; enabledPlatforms: string[] | null };

const NEXT = '/settings/connections';
const WEEK = 7 * 86_400_000;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const badgeClass: Record<AccountStatus['tone'], string> = { ok: 'badge--ok', warn: 'badge--warn', bad: 'badge--err' };

/** Settings › Accounts: whatever needs you first, every row says which account and what to do. */
export default function ConnectionsPage() {
  const { flash, dismiss } = useOAuthReturn();
  const { data: accounts, mutate, unauth } = useApi<Account[]>('/api/accounts');
  const { data: scheduled } = useApi<Scheduled[]>('/api/schedule');
  const { data: agent } = useApi<Agent>('/api/agent/settings');
  const now = useNow();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Back from OAuth: refetch, show the row as "Connecting…" until it lands,
  // then let its badge develop in.
  const [arriving, setArriving] = useState<string | null>(null);
  const [developed, setDeveloped] = useState<string | null>(null);
  const arrived = flash?.kind === 'success' ? flash.platform : null;
  useEffect(() => {
    if (!arrived) return;
    queueMicrotask(() => setArriving(arrived));
    mutate().finally(() => { setArriving(null); setDeveloped(arrived); });
  }, [arrived, mutate]);

  const connect = (p: Platform) => window.location.assign(`/api/oauth/${p}/start?next=${encodeURIComponent(NEXT)}`);
  const count = (p: Platform, statuses: Scheduled['status'][], since = 0) =>
    (scheduled ?? []).filter((s) => s.platform === p && statuses.includes(s.status) && new Date(s.scheduledAt).getTime() >= since).length;

  const disconnect = async (a: Account, name: string, canceled: number) => {
    setBusy(a.id);
    setError(null);
    try {
      await apiDelete(`/api/accounts/${a.id}`);
      await mutate();
      setConfirming(null);
      setOpen(null);
      toast(`${name} disconnected${canceled ? ` · ${plural(canceled, 'queued post')} canceled` : ''}`);
    } catch (e) {
      setError(`Couldn’t disconnect ${name}. ${friendlyApiError(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const connected = PLATFORMS
    .map((p) => {
      const acct = accounts?.find((a) => a.platform === p.id);
      return acct && { p, acct, s: accountStatus(acct, now, count(p.id, ['pending', 'publishing'])) };
    })
    .filter((x): x is { p: PlatformMeta; acct: Account; s: AccountStatus } => !!x)
    .sort((a, b) => a.s.rank - b.s.rank);
  const free = PLATFORMS.filter((p) => !accounts?.some((a) => a.platform === p.id));

  return (
    <div className="set-page">
      <PageHeader title="Accounts" sub="Where Sociafy posts. Anything that needs you is at the top." />
      <div className="stack">
        {flash && <FlashBanner flash={flash} onDismiss={dismiss} onRetry={() => { dismiss(); connect(flash.platform as Platform); }} />}
        {error && (
          <div role="alert" className="conn-banner conn-banner--err">
            <span className="conn-banner__text">{error}</span>
            <button type="button" className="btn ghost sm" onClick={() => setError(null)} aria-label="Dismiss"><Icon name="x" size={12} /></button>
          </div>
        )}
        {unauth && (
          <div className="conn-banner">
            <span className="conn-banner__text">Sign in to connect accounts.</span>
            <Link className="btn sm" href={`/sign-in?next=${encodeURIComponent(NEXT)}`}>Sign in</Link>
          </div>
        )}

        {accounts === undefined || !now ? (
          <p className="set-hint">Loading accounts…</p>
        ) : connected.length > 0 && (
          <ul className="conn-list">
            {connected.map(({ p, acct, s }) => {
              const expanded = open === acct.id;
              const pendingN = count(p.id, ['pending']);
              const failed = now ? count(p.id, ['failed'], now - WEEK) : 0;
              const autopilot = !!agent?.enabled && (agent.enabledPlatforms ?? []).includes(p.id);
              return (
                <li key={p.id} className="conn-row">
                  <div className="conn-row__main">
                    <Pglyph p={p.short} size="lg" />
                    <div className="conn-row__meta">
                      <div className="conn-row__name">
                        {p.name}
                        <span className={`badge ${badgeClass[s.tone]}${developed === p.id ? ' set-develop' : ''}`}>{s.badge}</span>
                      </div>
                      <div className="conn-row__handle">{handleOf(acct)}{acct.meta?.pageName ? ` · ${acct.meta.pageName}` : ''}</div>
                      <div className={`conn-row__sub${s.tone === 'bad' ? ' is-bad' : s.tone === 'warn' || failed ? ' is-warn' : ''}`}>
                        {s.line}
                        {failed > 0 && <> · <Link href="/dashboard">{plural(failed, 'post')} failed this week</Link></>}
                      </div>
                    </div>
                    <div className="conn-row__actions">
                      {arriving === p.id ? (
                        <span className="conn-row__done is-pending" role="status">Connecting…</span>
                      ) : s.broken ? (
                        <button type="button" className="btn primary sm" onClick={() => connect(p.id)} disabled={!!unauth}>
                          <Icon name="refresh" size={12} /> {acct.isStub ? 'Connect' : 'Reconnect'}
                        </button>
                      ) : s.soon ? (
                        <button type="button" className="btn sm" onClick={() => connect(p.id)} disabled={!!unauth}>Reconnect</button>
                      ) : null}
                      <button
                        type="button"
                        className="btn ghost sm conn-manage"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Close' : 'Manage'} ${p.name}`}
                        onClick={() => { setOpen(expanded ? null : acct.id); setConfirming(null); }}
                      >
                        {expanded ? 'Close' : 'Manage'}
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="conn-row__details">
                      <dl className="conn-facts">
                        <dt>Account</dt>
                        <dd>{handleOf(acct)}{acct.meta?.pageName ? ` · ${acct.meta.pageName}` : ''}</dd>
                        <dt>Access</dt>
                        <dd>{s.line}</dd>
                        <dt>Queued</dt>
                        <dd>{plural(pendingN, 'post')}</dd>
                        <dt>Autopilot</dt>
                        <dd>{agent ? (autopilot ? 'Posts here' : 'Not posting here') : '…'}</dd>
                        <dt>Connected</dt>
                        <dd>{new Date(acct.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</dd>
                      </dl>
                      {confirming === acct.id ? (
                        <div className="conn-confirm" role="alertdialog" aria-label={`Disconnect ${p.name}`}>
                          {/* Matches DELETE /api/accounts/[id]: pending posts → canceled, published history kept, platform dropped from Autopilot. */}
                          <p><strong>Disconnect {handleOf(acct)} from {p.name}?</strong></p>
                          <p>
                            {pendingN > 0 ? <>{plural(pendingN, 'queued post')} will be <strong>canceled</strong> and </> : <>Nothing is queued for {p.name}. </>}
                            Autopilot stops posting to {p.name}. Published history stays. You can reconnect any time{pendingN > 0 ? ', but canceled posts won’t come back' : ''}.
                          </p>
                          <div className="row">
                            <button type="button" className="btn sm" onClick={() => setConfirming(null)} disabled={busy === acct.id}>Keep connected</button>
                            <button type="button" className="btn sm conn-danger" onClick={() => disconnect(acct, p.name, pendingN)} disabled={busy === acct.id}>
                              {busy === acct.id ? 'Disconnecting…' : `Disconnect ${p.name}`}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="row">
                          {!s.broken && (
                            <button type="button" className="btn sm" onClick={() => connect(p.id)} disabled={!!unauth}>
                              <Icon name="refresh" size={12} /> Reconnect
                            </button>
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
        )}

        <div className="set-subh">{connected.length ? 'Add a platform' : 'Connect your first account'}</div>
        <ul className="conn-list">
          {free.map((p) => (
            <li key={p.id} className="conn-row">
              <div className="conn-row__main">
                <Pglyph p={p.short} size="lg" />
                <div className="conn-row__meta">
                  <div className="conn-row__name">{p.name}</div>
                  <div className="conn-row__sub">{p.tip}</div>
                </div>
                <div className="conn-row__actions">
                  {arriving === p.id ? (
                    <span className="conn-row__done is-pending" role="status">Connecting…</span>
                  ) : (
                    <button type="button" className="btn sm" onClick={() => connect(p.id)} disabled={!!unauth}>Connect</button>
                  )}
                </div>
              </div>
            </li>
          ))}
          {free.length === 0 && <li className="conn-row conn-row--empty">Every platform is connected.</li>}
        </ul>

        <p className="conn-support">
          Trouble connecting? Email <a href="mailto:support@sociafy.app">support@sociafy.app</a>.
        </p>
      </div>
    </div>
  );
}
