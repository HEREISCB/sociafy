'use client';

import React, { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { Button } from '../ui';
import { useApi, friendlyApiError } from '../../lib/ui/fetcher';

interface ShieldSettings {
  autoFetch: boolean;
  autoFetchBrand: string;
  slackWebhookUrl: string;
  alertEmail: string;
  lastAutoFetchAt: string | null;
}

const EMPTY: ShieldSettings = { autoFetch: false, autoFetchBrand: '', slackWebhookUrl: '', alertEmail: '', lastAutoFetchAt: null };
const SOURCES = 'News, Reddit, Hacker News and X';

/** Shared load-once + partial-save over /api/shield/settings (PUT accepts any subset). */
function useShieldSettings() {
  const { data, mutate } = useApi<{ settings: ShieldSettings }>('/api/shield/settings');
  const [s, setS] = useState<ShieldSettings>(EMPTY);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (data?.settings && !hydrated) {
      setS(data.settings);
      setHydrated(true);
    }
  }, [data, hydrated]);

  const save = async (fields: Partial<ShieldSettings>): Promise<boolean> => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/shield/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      setMsg({ ok: true, text: 'Saved' });
      await mutate();
      return true;
    } catch (e) {
      setMsg({ ok: false, text: friendlyApiError(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { saved: data?.settings ?? null, s, setS, hydrated, save, busy, msg };
}

const ago = (iso: string) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/**
 * One line above the inbox: what we watch, how often, when we last looked,
 * plus Edit and Scan now. The brand is prefilled from the Brand kit name
 * (client-side only; nothing saves until Save).
 */
const MonitoringSettings: React.FC<{ onScan: (brand: string) => void; scanning: boolean; suggested?: string | null }> = ({ onScan, scanning, suggested }) => {
  const { saved, s, setS, hydrated, save, busy, msg } = useShieldSettings();
  const [editing, setEditing] = useState(false);
  const savedBrand = saved?.autoFetchBrand.trim() ?? '';
  const prefill = !savedBrand && suggested?.trim() ? suggested.trim() : '';
  const [prefilled, setPrefilled] = useState(false);
  if (hydrated && prefill && !prefilled) { setPrefilled(true); setS((v) => ({ ...v, autoFetchBrand: v.autoFetchBrand || prefill })); }
  const brand = savedBrand || s.autoFetchBrand.trim();

  return (
    <section className="card shield-strip" aria-label="Monitoring">
      <span className="shield-strip-ic" aria-hidden="true"><Icon name="waveform" size={14} /></span>
      <div className="shield-strip-t">
        {savedBrand ? <>Watching <b>{savedBrand}</b></> : brand ? <>Not watching yet · <b>{brand}</b> from your Brand kit</> : <b>No brand set</b>}
        <span>
          {saved?.autoFetch && savedBrand ? 'Every 15 min' : 'Manual scans only'} · {SOURCES}
          {saved?.lastAutoFetchAt ? ` · last scan ${ago(saved.lastAutoFetchAt)}` : ''}
        </span>
      </div>
      <div className="shield-strip-acts">
        <button type="button" className="btn sm" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>Edit</button>
        <Button size="sm" variant="primary" busy={scanning} disabled={!brand} reason="Add a brand name to scan" onClick={() => onScan(brand)}>
          {scanning ? 'Scanning…' : 'Scan now'}
        </Button>
      </div>
      {editing && (
        <div className="shield-strip-form">
          <label className="field">
            <span className="set-label">Brand to watch</span>
            <input
              className="input"
              value={s.autoFetchBrand}
              onChange={(e) => setS((v) => ({ ...v, autoFetchBrand: e.target.value }))}
              placeholder="Company name or @handle"
              maxLength={120}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={s.autoFetch} onChange={(e) => setS((v) => ({ ...v, autoFetch: e.target.checked }))} />
            <span>Scan automatically every 15 min</span>
          </label>
          {s.autoFetch && !s.autoFetchBrand.trim() && <p className="set-hint err">Add a brand name or nothing gets scanned.</p>}
          <div className="set-actions">
            <Button size="sm" variant="primary" busy={busy} onClick={async () => { if (await save({ autoFetch: s.autoFetch, autoFetchBrand: s.autoFetchBrand })) setEditing(false); }}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <button type="button" className="btn sm ghost" onClick={() => setEditing(false)}>Cancel</button>
            {msg && !msg.ok && <span className="set-hint err" role="alert">{msg.text}</span>}
          </div>
        </div>
      )}
    </section>
  );
};

/** Crisis alert destinations (Reply settings › Alerts). */
export const AlertSettings: React.FC = () => {
  const { s, setS, save, busy, msg } = useShieldSettings();
  return (
    <div className="stack">
      <p className="set-hint">Get pinged when a scan finds a new crisis mention.</p>
      <div className="set-grid-2">
        <label className="field">
          <span className="set-label">Slack or Discord webhook</span>
          <input
            className="input"
            value={s.slackWebhookUrl}
            onChange={e => setS(v => ({ ...v, slackWebhookUrl: e.target.value }))}
            placeholder="https://hooks.slack.com/services/…"
          />
        </label>
        <label className="field">
          <span className="set-label">Alert email</span>
          <input
            className="input"
            type="email"
            value={s.alertEmail}
            onChange={e => setS(v => ({ ...v, alertEmail: e.target.value }))}
            placeholder="you@company.com"
          />
        </label>
      </div>
      <div className="set-actions">
        <Button size="sm" variant="primary" busy={busy} onClick={() => save({ slackWebhookUrl: s.slackWebhookUrl, alertEmail: s.alertEmail })}>
          {busy ? 'Saving…' : 'Save alerts'}
        </Button>
        {msg && <span className={msg.ok ? 'set-ok' : 'set-hint err'} role="status">{msg.text}</span>}
      </div>
    </div>
  );
};

export default MonitoringSettings;
