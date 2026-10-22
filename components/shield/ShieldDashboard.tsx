'use client';

import React, { useState } from 'react';
import { Empty, PageHeader, Seg, useToast } from '../ui';
import { useApi, apiPost } from '../../lib/ui/fetcher';
import { MentionCard, MentionReceipt, type ShieldActionRow } from './MentionCard';
import BrandKnowledge from './BrandKnowledge';
import ResponseSettings from './ResponseSettings';
import MonitoringSettings, { AlertSettings } from './MonitoringSettings';
import { keepaliveFetch, useDeferred } from '../settings-ui';

type ConnectedAccount = { platform: string; isStub: boolean };
type RsTab = 'alerts' | 'knowledge' | 'prompt';

const RS_TABS: { id: RsTab; label: string }[] = [
  { id: 'alerts', label: 'Alerts' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'prompt', label: 'Reply prompt' },
];
const needsYou = (a: ShieldActionRow) => a.status === 'pending' || a.status === 'failed';

/** Inbox first; what we watch sits in one line above it; reply settings below. */
const ShieldDashboard: React.FC = () => {
  const toast = useToast();
  const defer = useDeferred();
  const [scanning, setScanning] = useState(false);
  const [tab, setTab] = useState<'review' | 'all'>('review');
  const [rsTab, setRsTab] = useState<RsTab>('alerts');
  const [dismissed, setDismissed] = useState<string[]>([]);

  const { data: actionsData, mutate } = useApi<{ actions: ShieldActionRow[] }>('/api/shield/actions');
  const { data: accountsData } = useApi<ConnectedAccount[]>('/api/accounts');
  const { data: brand } = useApi<{ profile: { companyName: string | null } }>('/api/brand-kit');

  const actions = actionsData?.actions ?? [];
  const connectedPlatforms = (accountsData ?? []).filter(a => !a.isStub).map(a => a.platform);
  const pending = actions
    .filter((a) => needsYou(a) && !dismissed.includes(a.id))
    .sort((a, b) => Number(b.mention.sentimentLabel === 'crisis') - Number(a.mention.sentimentLabel === 'crisis'));
  const visible = tab === 'review' ? pending : actions;

  const scan = async (q: string) => {
    if (!q.trim()) return;
    setScanning(true);
    try {
      const res = await fetch('/api/shield/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: q.trim() }),
      });
      const d = await res.json().catch(() => ({})) as { error?: string; resolvedX?: { handle: string | null; displayName: string | null } };
      if (!res.ok) { toast(`Scan failed: ${d.error ?? res.status}`, { tone: 'err' }); return; }
      const before = pending.length;
      const fresh = await mutate();
      const after = ((fresh as { actions?: ShieldActionRow[] } | undefined)?.actions ?? []).filter(needsYou).length;
      const matched = d.resolvedX?.handle ? ` · matched @${d.resolvedX.handle} on X` : '';
      toast(after > before ? `Scan done · ${after - before} new to review${matched}` : `Scan done · nothing new${matched}`);
    } catch {
      toast('Scan failed: network error. Try again.', { tone: 'err' });
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

  // Dismiss can be undone for a few seconds; the reject request goes out after.
  const dismiss = (row: ShieldActionRow) => {
    setDismissed((d) => [...d, row.id]);
    defer(
      'Mention dismissed',
      async () => {
        const r = await keepaliveFetch(`/api/shield/actions/${row.id}/reject`, 'POST', {}).catch(() => null);
        if (!r?.ok) {
          setDismissed((d) => d.filter((x) => x !== row.id));
          toast('Couldn’t dismiss that mention. It’s back in your inbox.', { tone: 'err' });
          return;
        }
        await mutate();
      },
      () => setDismissed((d) => d.filter((x) => x !== row.id)),
    );
  };

  return (
    <div className="set-page shield">
      <PageHeader title="Mentions" sub="Coverage of your brand that may need a reply. Nothing posts without you." />
      <MonitoringSettings onScan={scan} scanning={scanning} suggested={brand?.profile.companyName} />

      <section className="card shield-inbox" aria-labelledby="inbox-head">
        <div className="shield-inbox-h">
          <h2 id="inbox-head">Inbox</h2>
          <Seg
            label="Show"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { id: 'review', label: <>To review <small className="seg-aside">{pending.length}</small></> },
              { id: 'all', label: <>All <small className="seg-aside">{actions.length}</small></> },
            ]}
          />
        </div>
        {!actionsData ? (
          <p className="set-needs-wait">Loading mentions…</p>
        ) : visible.length === 0 ? (
          <Empty icon="check" title={actions.length === 0 ? 'No mentions yet' : 'Inbox clear'}>
            {actions.length === 0
              ? 'Scan for your brand above. Negative coverage lands here, and you can draft a reply to each.'
              : 'New mentions that need a reply land here.'}
          </Empty>
        ) : (
          <div className="shield-list">
            {visible.map(row =>
              dismissed.includes(row.id) || !needsYou(row) ? (
                <MentionReceipt key={row.id} row={row} dismissed={dismissed.includes(row.id)} />
              ) : (
                <MentionCard key={row.id} row={row} onApprove={approve} onDismiss={dismiss} connectedPlatforms={connectedPlatforms} />
              ),
            )}
          </div>
        )}
      </section>

      <section className="card shield-rs" aria-label="Reply settings">
        <div className="shield-rs-tabs" role="tablist" aria-label="Reply settings">
          {RS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`rs-${t.id}`}
              aria-selected={rsTab === t.id}
              aria-controls="rs-pane"
              onClick={() => setRsTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div key={rsTab} className="shield-rs-pane" id="rs-pane" role="tabpanel" aria-labelledby={`rs-${rsTab}`}>
          {rsTab === 'alerts' ? <AlertSettings /> : rsTab === 'knowledge' ? <BrandKnowledge /> : <ResponseSettings />}
        </div>
      </section>
    </div>
  );
};

export default ShieldDashboard;
