'use client';

import React, { useState } from 'react';
import { Icon } from './icons';
import { apiDelete, apiPatch, apiPost, useApi, friendlyApiError } from '../lib/ui/fetcher';

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  dailyCreditCap: number;
  lastUsedAt: string | null;
  createdAt: string;
};

/** Schema default for api_keys.daily_credit_cap. Shown as the input's
 *  placeholder so the number a new key gets is never a mystery. Exported so the
 *  limits table on /developers quotes this number rather than a second copy. */
export const DEFAULT_CAP = 2_000;

/** Developer API keys panel. Keys authenticate /api/v1 requests and spend from
 *  this account's credit balance, so revoking is the kill switch. */
export const ApiKeys: React.FC = () => {
  const { data, isLoading, mutate } = useApi<ApiKey[]>('/api/keys');
  const [name, setName] = useState('');
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plaintext key, held in memory only until dismissed — there is no
  // endpoint that can return it again.
  const [fresh, setFresh] = useState<{ prefix: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const keys = data ?? [];

  async function create() {
    setBusy(true);
    setError(null);
    try {
      // dailyCreditCap was previously never sent, which made every cap other
      // than the 2,000 default unreachable from the UI even though the API
      // accepted one.
      const parsedCap = Number(cap);
      const r = await apiPost<{ prefix: string; key: string }>('/api/keys', {
        name: name.trim() || undefined,
        dailyCreditCap: Number.isInteger(parsedCap) && parsedCap > 0 ? parsedCap : undefined,
      });
      setFresh({ prefix: r.prefix, key: r.key });
      setName('');
      setCap('');
      setCopied(false);
      await mutate();
    } catch (e) {
      setError(friendlyApiError(e));
    } finally {
      setBusy(false);
    }
  }

  /** Caps are adjustable in place: the API's 429 tells developers to raise it
   *  here, and rotating a live key just to widen a limit is not a fix. */
  async function saveCap(k: ApiKey, next: string) {
    const value = Number(next);
    if (!Number.isInteger(value) || value < 1 || value === k.dailyCreditCap) return;
    setError(null);
    try {
      await apiPatch(`/api/keys/${k.id}`, { dailyCreditCap: value });
      await mutate();
    } catch (e) {
      setError(friendlyApiError(e));
      await mutate();
    }
  }

  async function revoke(k: ApiKey) {
    if (!window.confirm(`Revoke ${k.prefix}…? Any integration using this key stops working immediately.`)) return;
    setError(null);
    try {
      await apiDelete(`/api/keys/${k.id}`);
      await mutate();
    } catch (e) {
      setError(friendlyApiError(e));
    }
  }

  // id="api-keys" kept as the anchor target: it outlived the /usage panel and is
  // still what older links point at.
  return (
    <section className="usage-card" id="api-keys" style={{ scrollMarginTop: 24 }}>
      <h3>API keys</h3>
      <div className="sub" style={{ marginBottom: 14 }}>
        Call the Sociafy API from your own code. Requests authenticate with{' '}
        <code className="mono">Authorization: Bearer sfy_live_…</code> and spend credits from this account.
        <br />
        Each key has its own rolling 24-hour credit cap (default {DEFAULT_CAP.toLocaleString()}). Edit a
        key&apos;s cap below to change it — no need to rotate the key.
      </div>

      {fresh && (
        <div
          style={{
            border: '1px solid var(--line)', borderRadius: 10, padding: 12,
            background: 'var(--accent-soft)', marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            <Icon name="alert" size={12} /> Copy this key now — you won&apos;t see it again.
          </div>
          <div className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all', marginBottom: 8 }}>
            {fresh.key}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn sm"
              onClick={async () => {
                await navigator.clipboard.writeText(fresh.key).catch(() => {});
                setCopied(true);
              }}
            >
              <Icon name={copied ? 'check' : 'link'} size={12} /> {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn ghost sm" onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name (e.g. production)"
          maxLength={60}
          style={{
            flex: 1, minWidth: 0, padding: '6px 10px', fontSize: 12.5,
            border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)',
          }}
        />
        <input
          value={cap}
          onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder={`${DEFAULT_CAP} cr/day`}
          inputMode="numeric"
          title="Rolling 24-hour credit cap for this key"
          style={{
            width: 110, padding: '6px 10px', fontSize: 12.5,
            border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg)',
          }}
        />
        <button className="btn primary sm" onClick={create} disabled={busy}>
          <Icon name="plus" size={12} /> {busy ? 'Creating…' : 'New key'}
        </button>
      </div>

      {error && <div className="sub" style={{ color: 'var(--danger)', marginBottom: 10 }}>{error}</div>}

      {isLoading && <div className="sub">Loading keys…</div>}
      {!isLoading && keys.length === 0 && (
        <div className="sub">No API keys yet. Create one to start calling the API.</div>
      )}

      {keys.map((k) => (
        <div
          key={k.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0',
            borderTop: '1px solid var(--line)',
          }}
        >
          <Icon name="lock" size={13} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{k.name || 'Untitled key'}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              {k.prefix}… ·{' '}
              <input
                defaultValue={k.dailyCreditCap}
                onBlur={(e) => saveCap(k, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                inputMode="numeric"
                title="Rolling 24-hour credit cap. Saves on blur."
                style={{
                  width: 68, padding: '1px 4px', fontSize: 11, font: 'inherit',
                  border: '1px solid var(--line)', borderRadius: 5, background: 'var(--bg)',
                }}
              />
              cr/day cap ·{' '}
              {k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'never used'}
            </div>
          </div>
          <button className="btn ghost sm" onClick={() => revoke(k)}>
            <Icon name="trash" size={12} /> Revoke
          </button>
        </div>
      ))}
    </section>
  );
};
