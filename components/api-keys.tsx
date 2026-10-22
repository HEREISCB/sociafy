'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Icon } from './icons';
import { Button, Empty, Modal, Skeleton, useToast } from './ui';
import { apiDelete, apiPatch, apiPost, useApi, friendlyApiError } from '../lib/ui/fetcher';
import type { CreditsPayload } from './credits';

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  dailyCreditCap: number;
  lastUsedAt: string | null;
  createdAt: string;
  /** Rolling-24h spend, metered like the cap is enforced. */
  spent24h?: number;
};

/** Schema default for api_keys.daily_credit_cap. Shown as the input's
 *  placeholder so the number a new key gets is never a mystery. Exported so the
 *  limits table on /developers quotes this number rather than a second copy. */
export const DEFAULT_CAP = 2_000;

const n = (v: number) => v.toLocaleString('en-IN');
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** Developer API keys panel. Keys authenticate /api/v1 requests and spend from
 *  this account's credit balance, so revoking is the kill switch. */
export const ApiKeys: React.FC = () => {
  const { data, isLoading, mutate } = useApi<ApiKey[]>('/api/keys');
  const { data: credits } = useApi<CreditsPayload>('/api/credits');
  const toast = useToast();
  const [name, setName] = useState('');
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plaintext key, held in memory only until dismissed — there is no
  // endpoint that can return it again.
  const [fresh, setFresh] = useState<{ prefix: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const keys = data ?? [];

  async function create() {
    setBusy(true);
    setError(null);
    try {
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

  async function revoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await apiDelete(`/api/keys/${revoking.id}`);
      toast(`Revoked ${revoking.prefix}…`);
      setRevoking(null);
      await mutate();
    } catch (e) {
      toast(friendlyApiError(e), { tone: 'err' });
    } finally {
      setRevokeBusy(false);
    }
  }

  // id="api-keys" kept as the anchor target older links point at.
  return (
    <div className="acct-page" id="api-keys">
      <section className="card" aria-labelledby="create-key-head">
        <div className="card-head acct-card-head">
          <h3 id="create-key-head">Create a key</h3>
          <span className="acct-note">Keys spend this account’s credits</span>
        </div>
        <div className="card-body">
          <form className="acct-create" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Key name, e.g. production"
              aria-label="Key name"
              maxLength={60}
            />
            <input
              className="input mono"
              value={cap}
              onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={`${n(DEFAULT_CAP)} / day`}
              aria-label="Daily credit cap"
              inputMode="numeric"
            />
            <Button type="submit" variant="primary" busy={busy}>
              <Icon name="plus" size={14} /> {busy ? 'Creating…' : 'Create key'}
            </Button>
          </form>
          <p className="acct-note" style={{ marginTop: 8 }}>
            The cap is a rolling 24-hour limit per key. Leave it blank for {n(DEFAULT_CAP)} credits a day.
          </p>
          {error && <p className="field-error" role="alert" style={{ marginTop: 8 }}><Icon name="alert" size={12} /> {error}</p>}
        </div>

        {fresh && (
          <div className="acct-fresh" role="status">
            <strong>Copy this key now. It won’t be shown again.</strong>
            <div className="acct-keytxt arrive mono">{fresh.key}</div>
            <div className="row">
              <Button
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(fresh.key).catch(() => {});
                  setCopied(true);
                }}
              >
                <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>I’ve saved it</Button>
            </div>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="keys-head">
        <div className="card-head acct-card-head">
          <h3 id="keys-head">Your keys</h3>
          <span className="acct-note mono">{data ? `${keys.length} active` : ' '}</span>
        </div>
        {isLoading && <div className="card-body"><Skeleton h={14} w="50%" /></div>}
        {!isLoading && keys.length === 0 && (
          <Empty icon="lock" title="No keys yet">Name a key above and press Create key to call Sociafy from your own code.</Empty>
        )}
        {keys.map((k) => <KeyRow key={k.id} k={k} onSaved={() => mutate()} onRevoke={() => setRevoking(k)} />)}
        <div className="acct-card-foot">
          <span>
            {credits ? `${n(credits.balance)} credits left on this account. ` : ''}A key stops at its cap, or when credits run out.
          </span>
          <Link href="/developers/reference" className="acct-link">API reference</Link>
        </div>
      </section>

      <Modal
        open={!!revoking}
        onClose={() => { if (!revokeBusy) setRevoking(null); }}
        title={`Revoke “${revoking?.name || 'Untitled key'}”?`}
        footer={<>
          <Button onClick={() => setRevoking(null)} disabled={revokeBusy}>Keep key</Button>
          <Button variant="danger" busy={revokeBusy} onClick={revoke}>{revokeBusy ? 'Revoking…' : 'Revoke key'}</Button>
        </>}
      >
        <p className="acct-sheet-p">
          Anything using <span className="mono">{revoking?.prefix}…</span> stops working right away. This can’t be undone; you’d create a new key instead.
        </p>
      </Modal>
    </div>
  );
};

/** One key: 24h spend against its cap, and the cap editable in place with an explicit Save. */
function KeyRow({ k, onSaved, onRevoke }: { k: ApiKey; onSaved: () => Promise<unknown>; onRevoke: () => void }) {
  const [value, setValue] = useState(String(k.dailyCreditCap));
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState<{ ok: true } | { error: string } | null>(null);
  const v = Number(value);
  const dirty = value !== '' && v !== k.dailyCreditCap;
  const valid = Number.isInteger(v) && v >= 1 && v <= 100_000;
  const spent = k.spent24h ?? 0;

  const save = async () => {
    if (!dirty || !valid) return;
    setSaving(true);
    setState(null);
    try {
      await apiPatch(`/api/keys/${k.id}`, { dailyCreditCap: v });
      await onSaved();
      setState({ ok: true });
    } catch (e) {
      setState({ error: friendlyApiError(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="acct-krow">
      <div className="acct-kname">
        <div>{k.name || 'Untitled key'}</div>
        <div className="acct-note">
          <span className="mono">{k.prefix}…</span> · {k.lastUsedAt ? `last used ${day(k.lastUsedAt)}` : 'never used'}
        </div>
      </div>
      <Button size="sm" onClick={onRevoke}>Revoke</Button>
      <div className="acct-kmeter">
        <span>Spent in the last 24 h</span>
        <span className="mono">{n(spent)} / {n(k.dailyCreditCap)} cr</span>
        <div className="acct-meter thin" aria-hidden="true"><i style={{ transform: `scaleX(${Math.min(1, spent / k.dailyCreditCap)})` }} /></div>
      </div>
      <form className="acct-kcap" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label htmlFor={`cap-${k.id}`}>Daily cap</label>
        <input
          id={`cap-${k.id}`}
          className="input mono"
          value={value}
          onChange={(e) => { setValue(e.target.value.replace(/[^0-9]/g, '')); setState(null); }}
          inputMode="numeric"
          aria-invalid={dirty && !valid}
        />
        <span>credits</span>
        {/* Always rendered; it lights up once the cap changes. */}
        <Button
          type="submit" size="sm" variant={dirty ? 'primary' : undefined} busy={saving}
          disabled={!dirty || !valid}
          reason={value === '' ? 'Enter a number' : dirty && !valid ? '1 to 100,000' : undefined}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {!dirty && state && 'ok' in state && <span className="acct-saved"><Icon name="check" size={12} /> Saved</span>}
        {state && 'error' in state && <span className="field-error" role="alert">{state.error}</span>}
      </form>
    </div>
  );
}
