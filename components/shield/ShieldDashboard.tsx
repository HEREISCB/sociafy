'use client';

import React, { useState } from 'react';
import { useApi } from '../../lib/ui/fetcher';
import { Icon } from '../icons';
import { MentionCard, type ShieldActionRow } from './MentionCard';
import BrandKnowledge from './BrandKnowledge';
import ResponseSettings from './ResponseSettings';
import MonitoringSettings from './MonitoringSettings';
import AttentionQueue, { type AttentionData } from './AttentionQueue';
import Modal from './Modal';
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

// Platform filter for the mention list (filters by mention.source).
const PLATFORM_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: 'All platforms' },
  { id: 'x', label: 'X / Twitter' },
  { id: 'reddit', label: 'Reddit' },
  { id: 'google_news', label: 'Google News' },
  { id: 'hackernews', label: 'Hacker News' },
  { id: 'wikipedia', label: 'Wikipedia' },
];

const ShieldDashboard: React.FC = () => {
  const [brand, setBrand] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');
  const [source, setSource] = useState('all');
  const [resolvedNote, setResolvedNote] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'knowledge' | 'prompt' | 'monitoring' | 'attention'>(null);
  const [platform, setPlatform] = useState('all');
  const [sortBy, setSortBy] = useState<'recent' | 'severity'>('recent');

  const { data: actionsData, mutate } = useApi<{ actions: ShieldActionRow[] }>(
    '/api/shield/actions',
  );
  const { data: accountsData } = useApi<ConnectedAccount[]>('/api/accounts');
  // For the toolbar button badges (SWR dedupes with the modal components' calls).
  const { data: docsData } = useApi<{ documents: unknown[] }>('/api/shield/documents');
  const { data: settingsData } = useApi<{ settings: { systemPrompt: string; autoFetch: boolean } }>('/api/shield/settings');
  const { data: attentionData } = useApi<AttentionData>('/api/shield/attention');
  const docCount = docsData?.documents?.length ?? 0;
  const promptCustom = !!settingsData?.settings?.systemPrompt?.trim();
  const autoFetchOn = !!settingsData?.settings?.autoFetch;
  const attentionCount = attentionData?.counts?.total ?? 0;

  const actions = actionsData?.actions ?? [];
  const connectedPlatforms = (accountsData ?? [])
    .filter(a => !a.isStub)
    .map(a => a.platform);

  const filtered = actions
    .filter(a => {
      if (filter === 'pending') return a.status === 'pending';
      if (filter === 'crisis') return a.mention.sentimentLabel === 'crisis';
      if (filter === 'negative') return a.mention.sentimentLabel === 'negative';
      return true;
    })
    .filter(a => platform === 'all' || a.mention.source === platform)
    .sort((a, b) => (sortBy === 'severity' ? (b.mention.severity ?? 0) - (a.mention.severity ?? 0) : 0));

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

      {/* Compact tools toolbar — expand into full modals */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <ToolButton icon="shield" label="Brand Knowledge" badge={String(docCount)} onClick={() => setModal('knowledge')} />
        <ToolButton icon="settings" label="Response AI" badge={promptCustom ? 'custom' : 'default'} onClick={() => setModal('prompt')} />
        <ToolButton icon="refresh" label="Monitoring" badge={autoFetchOn ? 'on' : 'off'} onClick={() => setModal('monitoring')} />
        <ToolButton icon="bell" label="Needs attention" badge={attentionCount > 0 ? String(attentionCount) : undefined} onClick={() => setModal('attention')} />
      </div>

      {modal === 'knowledge' && (
        <Modal title="Brand Knowledge" subtitle="Reference text the AI grounds responses in" onClose={() => setModal(null)}>
          <BrandKnowledge />
        </Modal>
      )}
      {modal === 'prompt' && (
        <Modal title="Response AI — System Prompt" subtitle="Customize how the AI writes responses" onClose={() => setModal(null)}>
          <ResponseSettings />
        </Modal>
      )}
      {modal === 'monitoring' && (
        <Modal title="Monitoring & Alerts" subtitle="Scheduled auto-scans + crisis alerts" onClose={() => setModal(null)}>
          <MonitoringSettings />
        </Modal>
      )}
      {modal === 'attention' && (
        <Modal title="Needs your attention" subtitle="Mentions awaiting a response + failed posts" onClose={() => setModal(null)}>
          <AttentionQueue onReview={() => { setFilter('crisis'); setModal(null); }} />
        </Modal>
      )}

      {/* Filter pills + platform/sort */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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

        <span style={{ flex: 1 }} />

        <select
          value={platform}
          onChange={e => setPlatform(e.target.value)}
          title="Filter by platform"
          style={{ padding: '6px 10px', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--bg-elev)', color: 'var(--ink-2)', fontSize: 12.5, cursor: 'pointer' }}
        >
          {PLATFORM_FILTERS.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as 'recent' | 'severity')}
          title="Sort by"
          style={{ padding: '6px 10px', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--bg-elev)', color: 'var(--ink-2)', fontSize: 12.5, cursor: 'pointer' }}
        >
          <option value="recent">Newest first</option>
          <option value="severity">Highest severity</option>
        </select>
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

const ToolButton: React.FC<{
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  badge?: string;
  soon?: boolean;
  onClick?: () => void;
}> = ({ icon, label, badge, soon, onClick }) => (
  <button
    className="btn sm"
    onClick={onClick}
    disabled={soon}
    title={soon ? 'Coming soon' : label}
    style={{ display: 'flex', alignItems: 'center', gap: 7, opacity: soon ? 0.55 : 1 }}
  >
    <Icon name={icon} size={13} />
    {label}
    {badge && (
      <span className="mono" style={{ fontSize: 9, padding: '1px 5px', borderRadius: 100, background: 'var(--bg-sunk)', color: 'var(--ink-3)' }}>
        {badge}
      </span>
    )}
    {soon && (
      <span className="mono" style={{ fontSize: 8, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '1px 4px', borderRadius: 100, background: 'var(--bg-sunk)', color: 'var(--ink-3)' }}>
        soon
      </span>
    )}
  </button>
);

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
