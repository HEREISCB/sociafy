'use client';

import React, { useEffect, useState } from 'react';
import { useApi, friendlyApiError } from '../../lib/ui/fetcher';

interface ShieldSettings {
  autoFetch: boolean;
  autoFetchBrand: string;
  slackWebhookUrl: string;
  alertEmail: string;
  lastAutoFetchAt: string | null;
}

const EMPTY: ShieldSettings = { autoFetch: false, autoFetchBrand: '', slackWebhookUrl: '', alertEmail: '', lastAutoFetchAt: null };

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

  const save = async (fields: Partial<ShieldSettings>) => {
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
    } catch (e) {
      setMsg({ ok: false, text: friendlyApiError(e) });
    } finally {
      setBusy(false);
    }
  };

  return { s, setS, save, busy, msg };
}

/** Brand + scheduled scans, with a manual scan. Top of /settings/mentions. */
const MonitoringSettings: React.FC<{ onScan: (brand: string) => void; scanning: boolean }> = ({ onScan, scanning }) => {
  const { s, setS, save, busy, msg } = useShieldSettings();
  const brand = s.autoFetchBrand.trim();
  const lastScan = s.lastAutoFetchAt ? new Date(s.lastAutoFetchAt).toLocaleString() : null;

  return (
    <section className="card shield-form" aria-label="Monitoring">
      <label className="set-field">
        <span className="set-label">Brand to monitor</span>
        <input
          className="input"
          value={s.autoFetchBrand}
          onChange={e => setS(v => ({ ...v, autoFetchBrand: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter' && brand && !scanning) onScan(brand); }}
          placeholder="Company name or @handle"
          maxLength={120}
        />
      </label>
      <label className="set-check">
        <input
          type="checkbox"
          checked={s.autoFetch}
          onChange={e => setS(v => ({ ...v, autoFetch: e.target.checked }))}
        />
        <span>
          Scan automatically
          <span className="set-hint"> · {lastScan ? `last scan ${lastScan}` : 'news, Reddit, Hacker News and X'}</span>
        </span>
      </label>
      {s.autoFetch && !brand && <p className="set-hint err">Add a brand name or nothing gets scanned.</p>}
      <div className="set-actions">
        <button
          className="btn primary"
          onClick={() => save({ autoFetch: s.autoFetch, autoFetchBrand: s.autoFetchBrand })}
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn" onClick={() => onScan(brand)} disabled={scanning || !brand}>
          {scanning ? 'Scanning…' : 'Scan now'}
        </button>
        {msg && <span className={msg.ok ? 'set-ok' : 'set-hint err'} role="status">{msg.text}</span>}
      </div>
    </section>
  );
};

/** Crisis alert destinations, behind "Advanced". */
export const AlertSettings: React.FC = () => {
  const { s, setS, save, busy, msg } = useShieldSettings();
  return (
    <div className="stack">
      <p className="set-hint">Get pinged when a scan finds a new crisis mention.</p>
      <label className="set-field">
        <span className="set-label">Slack or Discord webhook URL</span>
        <input
          className="input"
          value={s.slackWebhookUrl}
          onChange={e => setS(v => ({ ...v, slackWebhookUrl: e.target.value }))}
          placeholder="https://hooks.slack.com/services/…"
        />
      </label>
      <label className="set-field">
        <span className="set-label">Alert email</span>
        <input
          className="input"
          type="email"
          value={s.alertEmail}
          onChange={e => setS(v => ({ ...v, alertEmail: e.target.value }))}
          placeholder="you@company.com"
        />
      </label>
      <div className="set-actions">
        <button
          className="btn sm"
          onClick={() => save({ slackWebhookUrl: s.slackWebhookUrl, alertEmail: s.alertEmail })}
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save alerts'}
        </button>
        {msg && <span className={msg.ok ? 'set-ok' : 'set-hint err'} role="status">{msg.text}</span>}
      </div>
    </div>
  );
};

export default MonitoringSettings;
