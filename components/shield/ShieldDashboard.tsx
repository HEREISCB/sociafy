'use client';

import React, { useState } from 'react';
import { useApi, apiPost } from '../../lib/ui/fetcher';
import { MentionCard, type ShieldActionRow } from './MentionCard';
import BrandKnowledge from './BrandKnowledge';
import ResponseSettings from './ResponseSettings';
import MonitoringSettings, { AlertSettings } from './MonitoringSettings';

type ConnectedAccount = { platform: string; isStub: boolean };

/** Brand monitoring: one settings form, one inbox, advanced bits folded away. */
const ShieldDashboard: React.FC = () => {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [resolvedNote, setResolvedNote] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const { data: actionsData, mutate } = useApi<{ actions: ShieldActionRow[] }>('/api/shield/actions');
  const { data: accountsData } = useApi<ConnectedAccount[]>('/api/accounts');

  const actions = actionsData?.actions ?? [];
  const connectedPlatforms = (accountsData ?? []).filter(a => !a.isStub).map(a => a.platform);
  const pending = actions.filter(a => a.status === 'pending');
  const visible = showAll ? actions : pending;

  const scan = async (brand: string) => {
    if (!brand.trim()) return;
    setScanning(true);
    setScanError(null);
    try {
      const res = await fetch('/api/shield/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: brand.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setScanError(d.error ?? 'Scan failed');
      } else {
        const d = await res.json().catch(() => ({})) as {
          resolvedX?: { handle: string | null; displayName: string | null };
        };
        setResolvedNote(d.resolvedX?.handle
          ? `Matched @${d.resolvedX.handle}${d.resolvedX.displayName ? ` (${d.resolvedX.displayName})` : ''}`
          : null);
        await mutate();
      }
    } catch {
      setScanError('Network error');
    } finally {
      setScanning(false);
    }
  };

  // apiPost throws on a non-2xx so the card can report the failure. Refresh
  // either way: on failure the action row is now 'failed' (retryable).
  const approve = async (id: string, script: string, targetPlatform: string | null) => {
    try {
      await apiPost(`/api/shield/actions/${id}/approve`, { script, targetPlatform });
    } finally {
      await mutate();
    }
  };

  const reject = async (id: string) => {
    try {
      await apiPost(`/api/shield/actions/${id}/reject`, {});
    } finally {
      await mutate();
    }
  };

  return (
    <div className="shield">
      <MonitoringSettings onScan={scan} scanning={scanning} />
      {scanError && <p className="set-error" role="alert">{scanError}</p>}
      {resolvedNote && !scanError && <p className="set-hint" role="status">{resolvedNote}</p>}

      <section className="card" aria-labelledby="mentions-head">
        <div className="card-head">
          <h3 id="mentions-head">Mentions</h3>
          <div className="shield-tabs" role="group" aria-label="Show">
            <button className={!showAll ? 'on' : undefined} aria-pressed={!showAll} onClick={() => setShowAll(false)}>
              To review <span className="mono">{pending.length}</span>
            </button>
            <button className={showAll ? 'on' : undefined} aria-pressed={showAll} onClick={() => setShowAll(true)}>
              All <span className="mono">{actions.length}</span>
            </button>
          </div>
        </div>
        {visible.length === 0 ? (
          <div className="empty-state">
            <h3>{actions.length === 0 ? 'No mentions yet' : 'Nothing to review'}</h3>
            <p>
              {actions.length === 0
                ? 'Add your brand above and scan. Negative coverage lands here with a draft reply.'
                : 'New mentions that need a reply will show up here.'}
            </p>
          </div>
        ) : (
          <div className="shield-list">
            {visible.map(row => (
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
      </section>

      <details className="card shield-advanced">
        <summary>Advanced</summary>
        <div className="shield-advanced-body">
          <section>
            <h4>Crisis alerts</h4>
            <AlertSettings />
          </section>
          <section>
            <h4>Brand knowledge</h4>
            <BrandKnowledge />
          </section>
          <section>
            <h4>Custom AI prompt</h4>
            <ResponseSettings />
          </section>
        </div>
      </details>
    </div>
  );
};

export default ShieldDashboard;
