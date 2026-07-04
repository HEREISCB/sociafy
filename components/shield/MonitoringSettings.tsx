'use client';

import React, { useEffect, useState } from 'react';
import { useApi } from '../../lib/ui/fetcher';
import { Icon } from '../icons';

interface ShieldSettings {
  autoFetch: boolean;
  autoFetchBrand: string;
  slackWebhookUrl: string;
  alertEmail: string;
  lastAutoFetchAt: string | null;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--line-2)',
  background: 'var(--bg-sunk)',
  color: 'var(--ink)',
  fontSize: 13,
};

const labelStyle: React.CSSProperties = { fontSize: 12.5, fontWeight: 500, color: 'var(--ink-2)' };

/** Scheduled auto-scan + crisis-alert settings. Saves to /api/shield/settings. */
const MonitoringSettings: React.FC = () => {
  const { data, mutate } = useApi<{ settings: ShieldSettings }>('/api/shield/settings');
  const [s, setS] = useState<ShieldSettings>({ autoFetch: false, autoFetchBrand: '', slackWebhookUrl: '', alertEmail: '', lastAutoFetchAt: null });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (data?.settings && !hydrated) {
      setS(data.settings);
      setHydrated(true);
    }
  }, [data, hydrated]);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      await fetch('/api/shield/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoFetch: s.autoFetch,
          autoFetchBrand: s.autoFetchBrand,
          slackWebhookUrl: s.slackWebhookUrl,
          alertEmail: s.alertEmail,
        }),
      });
      setSaved(true);
      await mutate();
    } finally {
      setBusy(false);
    }
  };

  const lastScan = s.lastAutoFetchAt ? new Date(s.lastAutoFetchAt).toLocaleString() : 'never';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Auto-fetch */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={() => setS(v => ({ ...v, autoFetch: !v.autoFetch }))}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 'var(--r)', border: '1px solid var(--line-2)', background: s.autoFetch ? 'var(--ink)' : 'var(--bg-sunk)', color: s.autoFetch ? 'var(--bg)' : 'var(--ink)', cursor: 'pointer', textAlign: 'left' }}
        >
          <Icon name="refresh" size={14} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Auto-fetch (scheduled scans)</div>
            <div style={{ fontSize: 11.5, opacity: 0.8 }}>Re-scan your brand automatically on the monitoring schedule.</div>
          </div>
          <span className="mono" style={{ fontSize: 10, padding: '2px 8px', borderRadius: 100, background: s.autoFetch ? 'oklch(1 0 0 / 0.18)' : 'var(--bg-elev)' }}>
            {s.autoFetch ? 'ON' : 'OFF'}
          </span>
        </button>
        <label style={labelStyle}>Brand / handle to monitor</label>
        <input
          style={inputStyle}
          value={s.autoFetchBrand}
          onChange={e => setS(v => ({ ...v, autoFetchBrand: e.target.value }))}
          placeholder="e.g. New Delhi Municipal Council Official or @tweetndmc"
        />
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>Last auto-scan: {lastScan}</div>
      </section>

      {/* Alerts */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Crisis alerts</div>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
          Get pinged the moment a new <strong>crisis</strong> mention appears — on a scheduled or manual scan.
        </p>
        <label style={labelStyle}>Slack / Discord incoming webhook URL</label>
        <input
          style={inputStyle}
          value={s.slackWebhookUrl}
          onChange={e => setS(v => ({ ...v, slackWebhookUrl: e.target.value }))}
          placeholder="https://hooks.slack.com/services/…  (Discord webhooks work too)"
        />
        <label style={labelStyle}>Alert email</label>
        <input
          style={inputStyle}
          type="email"
          value={s.alertEmail}
          onChange={e => setS(v => ({ ...v, alertEmail: e.target.value }))}
          placeholder="you@company.com"
        />
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
          Email needs RESEND_API_KEY set on the server; the webhook works with no extra config.
        </div>
      </section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
        {saved && <span className="mono" style={{ fontSize: 11, color: 'oklch(0.55 0.13 145)' }}>Saved ✓</span>}
        <button className="btn primary sm" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  );
};

export default MonitoringSettings;
