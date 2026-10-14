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

  // id="api-keys" kept as the anchor target older links point at.
  return (
    <section className="card" id="api-keys">
      <div className="api-create">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name, e.g. production"
          aria-label="Key name"
          maxLength={60}
        />
        <input
          className="input mono cap"
          value={cap}
          onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder={`${DEFAULT_CAP} / day`}
          aria-label="Daily credit cap"
          inputMode="numeric"
          title="Rolling 24-hour credit cap for this key"
        />
        <button className="btn primary" onClick={create} disabled={busy}>
          <Icon name="plus" size={14} /> {busy ? 'Creating…' : 'New key'}
        </button>
      </div>

      {fresh && (
        <div className="api-fresh" role="status">
          <strong className="set-label">Copy this key now. You won&apos;t see it again.</strong>
          <div className="api-fresh-key">{fresh.key}</div>
          <div className="row">
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

      {error && <p className="set-error api-row">{error}</p>}

      {isLoading && <div className="plan-empty">Loading…</div>}
      {!isLoading && keys.length === 0 && <div className="plan-empty">No keys yet.</div>}

      {keys.map((k) => (
        <div key={k.id} className="api-row">
          <div className="api-row-main">
            <div className="api-row-name">{k.name || 'Untitled key'}</div>
            <div className="api-row-meta">
              <span className="mono">{k.prefix}…</span> ·
              <input
                className="input"
                defaultValue={k.dailyCreditCap}
                onBlur={(e) => saveCap(k, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                inputMode="numeric"
                aria-label={`Daily credit cap for ${k.name || k.prefix}`}
                title="Rolling 24-hour credit cap. Saves when you leave the field."
              />
              credits / day ·{' '}
              {k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'never used'}
            </div>
          </div>
          <button className="btn ghost sm" onClick={() => revoke(k)}>Revoke</button>
        </div>
      ))}
    </section>
  );
};
