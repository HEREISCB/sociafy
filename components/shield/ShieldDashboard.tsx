'use client';

import React, { useState } from 'react';
import { useApi } from '../../lib/ui/fetcher';
import { Icon } from '../icons';
import { MentionCard, type ShieldActionRow } from './MentionCard';
import BrandKnowledge from './BrandKnowledge';
import type { SentimentLabel } from '../../lib/db/schema';

type FilterType = 'all' | 'crisis' | 'negative' | 'pending';

type ConnectedAccount = { platform: string; isStub: boolean };

// Scan source options. `sources: undefined` = scan everything.
const SOURCE_OPTIONS: { id: string; label: string; sources?: string[] }[] = [
  { id: 'all', label: 'All sources' },
  { id: 'x', label: 'X / Twitter only', sources: ['x'] },
  { id: 'reddit', label: 'Reddit only', sources: ['reddit'] },
  { id: 'news', label: 'Google News only', sources: ['google_news'] },
  { id: 'hn', label: 'Hacker News only', sources: ['hackernews'] },
  { id: 'wikipedia', label: 'Wikipedia only', sources: ['wikipedia'] },
];

const ShieldDashboard: React.FC = () => {
  const [brand, setBrand] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');
  const [source, setSource] = useState('all');
  const [resolvedNote, setResolvedNote] = useState<string | null>(null);

  const { data: actionsData, mutate } = useApi<{ actions: ShieldActionRow[] }>(
    '/api/shield/actions',
  );
  const { data: accountsData } = useApi<ConnectedAccount[]>('/api/accounts');

  const actions = actionsData?.actions ?? [];
  const connectedPlatforms = (accountsData ?? [])
    .filter(a => !a.isStub)
    .map(a => a.platform);

  const filtered = actions.filter(a => {
    if (filter === 'pending') return a.status === 'pending';
    if (filter === 'crisis') return a.mention.sentimentLabel === 'crisis';
    if (filter === 'negative') return a.mention.sentimentLabel === 'negative';
    return true;
  });

  const stats = {
    total: actions.length,
    crisis: actions.filter(a => a.mention.sentimentLabel === 'crisis').length,
    pending: actions.filter(a => a.status === 'pending').length,
  };

  const scan = async () => {
    if (!brand.trim()) return;
    setScanning(true);
    setScanError(null);
    try {
      const opt = SOURCE_OPTIONS.find(o => o.id === source);
      const res = await fetch('/api/shield/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: brand.trim(), sources: opt?.sources }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setScanError(d.error ?? 'Scan failed');
      } else {
        const d = await res.json().catch(() => ({})) as {
          resolvedX?: { handle: string | null; displayName: string | null };
        };
        if (d.resolvedX?.handle) {
          setResolvedNote(
            `Resolved to @${d.resolvedX.handle}${d.resolvedX.displayName ? ` — ${d.resolvedX.displayName}` : ''}`,
          );
        } else {
          setResolvedNote(null);
        }
        await mutate();
      }
    } catch (e) {
      setScanError('Network error');
    } finally {
      setScanning(false);
    }
  };

  const approve = async (id: string, script: string, targetPlatform: string | null) => {
    await fetch(`/api/shield/actions/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, targetPlatform }),
    });
    await mutate();
  };

  const reject = async (id: string) => {
    await fetch(`/api/shield/actions/${id}/reject`, { method: 'POST' });
    await mutate();
  };

  const FILTERS: { id: FilterType; label: string; count?: number }[] = [
    { id: 'all', label: 'All', count: stats.total },
    { id: 'crisis', label: 'Crisis', count: stats.crisis },
    { id: 'negative', label: 'Negative' },
    { id: 'pending', label: 'Pending', count: stats.pending },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Hero header */}
      <div
        style={{
          background: 'var(--ink)',
          color: 'var(--bg)',
          borderRadius: 'var(--r-lg)',
          padding: '22px 26px',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0,
            background:
              'radial-gradient(circle at 90% 10%, oklch(0.42 0.16 55 / 0.45), transparent 55%), radial-gradient(circle at 5% 110%, oklch(0.34 0.20 25 / 0.32), transparent 60%)',
            pointerEvents: 'none',
          }}
        />
        <div style={{ position: 'relative', display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 300px' }}>
            <div
              className="mono"
              style={{
                fontSize: 10.5, letterSpacing: '0.18em', textTransform: 'uppercase',
                color: 'oklch(0.72 0.18 55)', marginBottom: 10,
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 0 4px oklch(0.42 0.16 55 / 0.35)' }} />
              06 / Reputation Shield
            </div>
            <h2 style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.025em', lineHeight: 1.15 }}>
              Monitor your brand.{' '}
              <em style={{ color: 'var(--accent)', fontStyle: 'normal' }}>Respond instantly.</em>
            </h2>
            <p style={{ margin: '10px 0 0', fontSize: 13, color: 'oklch(0.75 0 0)', lineHeight: 1.55, maxWidth: '52ch' }}>
              Scans news, HN, Reddit, and X for negative coverage — surfaces a draft response you can edit and publish in one click.
            </p>
          </div>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 28, alignItems: 'flex-end', padding: '4px 0' }}>
            <StatCell label="Total" value={stats.total} />
            <StatCell label="Crisis" value={stats.crisis} warn={stats.crisis > 0} />
            <StatCell label="Pending" value={stats.pending} warn={stats.pending > 0} />
          </div>
        </div>
      </div>

      {/* Scan bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input
          type="text"
          value={brand}
          onChange={e => setBrand(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !scanning && scan()}
          placeholder="Brand or company name to scan…"
          style={{
            flex: 1,
            padding: '10px 14px',
            borderRadius: 'var(--r)',
            border: '1px solid var(--line-2)',
            background: 'var(--bg-sunk)',
            color: 'var(--ink)',
            fontSize: 14,
          }}
        />
        <select
          value={source}
          onChange={e => setSource(e.target.value)}
          title="Which sources to scan"
          style={{
            padding: '10px 12px',
            borderRadius: 'var(--r)',
            border: '1px solid var(--line-2)',
            background: 'var(--bg-sunk)',
            color: 'var(--ink)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {SOURCE_OPTIONS.map(o => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <button
          className="btn primary"
          onClick={scan}
          disabled={scanning || !brand.trim()}
          style={{ whiteSpace: 'nowrap' }}
        >
          <Icon name="target" size={13} />
          {scanning ? 'Scanning…' : 'Scan Now'}
        </button>
      </div>

      {scanError && (
        <div style={{ padding: '10px 14px', background: 'oklch(0.96 0.05 25)', border: '1px solid oklch(0.88 0.12 25)', borderRadius: 'var(--r-sm)', fontSize: 13, color: 'oklch(0.38 0.18 25)' }}>
          <Icon name="alert" size={12} /> {scanError}
        </div>
      )}

      {resolvedNote && !scanError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px', background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', fontSize: 12.5, color: 'var(--ink-2)' }}>
          <Icon name="target" size={12} /> <span><strong>Smart match:</strong> {resolvedNote}</span>
        </div>
      )}

      {/* Brand knowledge base — grounds AI responses */}
      <BrandKnowledge />

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className="btn sm"
            style={{
              background: filter === f.id ? 'var(--ink)' : 'var(--bg-elev)',
              color: filter === f.id ? 'var(--bg)' : 'var(--ink-2)',
              borderColor: filter === f.id ? 'var(--ink)' : 'var(--line)',
              gap: 6,
            }}
          >
            {f.label}
            {f.count !== undefined && (
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  padding: '1px 5px',
                  borderRadius: 100,
                  background: filter === f.id ? 'oklch(1 0 0 / 0.15)' : 'var(--bg-sunk)',
                  color: filter === f.id ? 'var(--bg)' : 'var(--ink-3)',
                }}
              >
                {f.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Mention cards */}
      {filtered.length === 0 ? (
        <div
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            border: '1px dashed var(--line-2)',
            borderRadius: 'var(--r-lg)',
            color: 'var(--ink-3)',
          }}
        >
          <Icon name="shield" size={24} />
          <p style={{ margin: '12px 0 4px', fontSize: 14, fontWeight: 500, color: 'var(--ink-2)' }}>
            {actions.length === 0 ? 'No mentions yet' : 'No mentions match this filter'}
          </p>
          <p style={{ margin: 0, fontSize: 13 }}>
            {actions.length === 0
              ? 'Enter a brand name above and click Scan Now to monitor your reputation.'
              : 'Try a different filter or run a new scan.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(row => (
            <MentionCard
              key={row.id}
              row={row}
              onApprove={approve}
              onReject={reject}
              connectedPlatforms={connectedPlatforms}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const StatCell: React.FC<{ label: string; value: number; warn?: boolean }> = ({ label, value, warn }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <span className="mono" style={{ fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: warn && value > 0 ? 'var(--warn)' : 'oklch(0.7 0 0)' }}>
      {label}
    </span>
    <span className="mono" style={{ fontSize: 28, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1, color: warn && value > 0 ? 'var(--warn)' : 'var(--bg)' }}>
      {String(value).padStart(2, '0')}
    </span>
  </div>
);

export default ShieldDashboard;
