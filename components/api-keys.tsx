'use client';

import React, { useState } from 'react';
import { Icon } from './icons';
import { apiDelete, apiPost, useApi, friendlyApiError } from '../lib/ui/fetcher';

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  dailyCreditCap: number;
  lastUsedAt: string | null;
  createdAt: string;
};

/** Developer API keys panel. Keys authenticate /api/v1 requests and spend from
 *  this account's credit balance, so revoking is the kill switch. */
export const ApiKeys: React.FC = () => {
  const { data, isLoading, mutate } = useApi<ApiKey[]>('/api/keys');
  const [name, setName] = useState('');
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
      const r = await apiPost<{ prefix: string; key: string }>('/api/keys', { name: name.trim() || undefined });
      setFresh({ prefix: r.prefix, key: r.key });
      setName('');
      setCopied(false);
      await mutate();
    } catch (e) {
      setError(friendlyApiError(e));
    } finally {
      setBusy(false);
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

  // id="api-keys" is the sidebar link's target — this panel sits below the
  // ledger, so without the anchor /usage opens well above it.
  return (
    <section className="usage-card" id="api-keys" style={{ marginTop: 28, scrollMarginTop: 24 }}>
      <h3>API keys</h3>
      <div className="sub" style={{ marginBottom: 14 }}>
        Call the Sociafy API from your own code. Requests authenticate with{' '}
        <code className="mono">Authorization: Bearer sfy_live_…</code> and spend credits from this account.
        {' '}<a href="https://github.com/HEREISCB/sociafy/blob/main/docs/api.md" target="_blank" rel="noreferrer">API docs →</a>
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
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              {k.prefix}… · {k.dailyCreditCap.toLocaleString()} cr/day cap ·{' '}
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
