'use client';

import React, { useEffect, useState } from 'react';
import { Icon } from './icons';
import { apiPatch, useApi } from '../lib/ui/fetcher';
import type { Niche } from '../lib/db/schema';

type AgentSettings = {
  enabled: boolean;
  instructions: string;
  cadencePerWeek: number;
  autoPublishThreshold: number;
  brandSafetyStrict: boolean;
  niches: Niche[];
  voiceTemplate: 'me' | 'punchy' | 'thoughtful' | 'data-led';
  quietHours: { start: string; end: string };
  lastRunAt: string | null;
};

type Activity = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

const NICHE_LABELS: Record<Niche, string> = {
  saas: 'Solo SaaS founders',
  'creator-economy': 'Creator economy',
  marketing: 'Indie marketing',
  ai: 'AI tooling',
  design: 'Design',
  devtools: 'Dev tools',
  fintech: 'Fintech',
  media: 'Media',
  community: 'Community',
};

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const KIND_LABEL: Record<string, { label: string; tone: 'accent' | 'warn' | '' }> = {
  trend_spotted: { label: 'Trend', tone: 'accent' },
  agent_drafted: { label: 'Drafted', tone: '' },
  auto_publish: { label: 'Scheduled', tone: 'accent' },
  agent_held: { label: 'Held', tone: 'warn' },
  publish_failed: { label: 'Failed', tone: 'warn' },
  manual_publish: { label: 'Posted', tone: '' },
  platform_connected: { label: 'Connected', tone: '' },
  platform_disconnected: { label: 'Disconnected', tone: '' },
  draft_created: { label: 'Drafted', tone: '' },
  draft_scheduled: { label: 'Scheduled', tone: '' },
  agent_enabled: { label: 'Enabled', tone: '' },
  agent_disabled: { label: 'Paused', tone: '' },
  onboarded: { label: 'Onboarded', tone: '' },
};

const DEMO_FEED: Activity[] = [
  { id: 'demo-1', kind: 'trend_spotted', title: 'Spotted "agentic content" mentions', body: 'Adjacent niche signal up 312%. Drafting your angle.', meta: null, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() },
  { id: 'demo-2', kind: 'agent_drafted', title: 'Drafted 3 posts from your latest newsletter', body: 'Variant B scored highest against your style guide.', meta: null, createdAt: new Date(Date.now() - 14 * 60_000).toISOString() },
  { id: 'demo-3', kind: 'agent_held', title: 'Held a draft — tone mismatch', body: 'Used "game-changing" twice. Rewriting and re-queuing.', meta: null, createdAt: new Date(Date.now() - 60 * 60_000).toISOString() },
];

const AgentPage: React.FC = () => {
  const { data: settings, mutate: refetchSettings, unauth } = useApi<AgentSettings>('/api/agent/settings');
  const { data: activity } = useApi<Activity[]>('/api/activity?limit=30');

  const [autopilot, setAutopilot] = useState(false);
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [cadence, setCadence] = useState(4);
  const [threshold, setThreshold] = useState(90);
  const [strict, setStrict] = useState(true);
  const [savingInstr, setSavingInstr] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setAutopilot(settings.enabled);
    setInstructions(settings.instructions);
    setCadence(settings.cadencePerWeek);
    setThreshold(settings.autoPublishThreshold);
    setStrict(settings.brandSafetyStrict);
  }, [settings]);

  const saveAutopilot = async (next: boolean) => {
    setAutopilot(next);
    try {
      await apiPatch('/api/agent/settings', { enabled: next });
      await refetchSettings();
    } catch {
      setAutopilot(!next);
    }
  };

  const saveInstructions = async () => {
    setSavingInstr(true);
    try {
      await apiPatch('/api/agent/settings', { instructions });
      await refetchSettings();
      setEditing(false);
    } finally {
      setSavingInstr(false);
    }
  };

  const updateField = async (patch: Partial<AgentSettings>) => {
    try {
      await apiPatch('/api/agent/settings', patch);
      await refetchSettings();
    } catch {/* ignore */}
  };

  const niches = settings?.niches ?? [];
  const feed = activity && activity.length > 0 ? activity : DEMO_FEED;

  return (
    <div className="two-col">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="card" style={{ background: autopilot ? 'var(--bg-elev)' : 'var(--bg-sunk)' }}>
          <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 16, alignItems: 'center' }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: autopilot ? 'var(--ink)' : 'var(--bg-sunk)', color: autopilot ? 'var(--accent)' : 'var(--ink-3)', display: 'grid', placeItems: 'center', position: 'relative' }}>
              <Icon name="bolt" size={18} />
              {autopilot && <span style={{ position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: '50%', background: 'var(--good)', border: '2px solid var(--bg-elev)' }} />}
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 550, letterSpacing: '-0.01em', marginBottom: 2 }}>
                Autopilot is {autopilot ? 'running' : 'paused'}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                {autopilot
                  ? `Monitoring ${niches.length} niches, drafting on a ${cadence}/week cadence, auto-publishing posts scoring ≥ ${threshold}.`
                  : "I'll keep watching but won't draft or post without you."}
              </div>
            </div>
            <button className={`btn ${autopilot ? '' : 'primary'}`} onClick={() => saveAutopilot(!autopilot)} disabled={unauth}>
              {autopilot ? <><Icon name="pause" size={12} /> Pause</> : <><Icon name="play" size={12} /> Resume</>}
            </button>
          </div>
        </div>

        {unauth && (
          <div style={{ padding: 12, background: 'rgba(124,77,255,0.06)', border: '1px solid rgba(124,77,255,0.2)', borderRadius: 10, fontSize: 13 }}>
            Demo mode. <a href="/sign-in?next=/dashboard" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>Sign in</a> to configure a real autopilot.
          </div>
        )}

        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="chat" size={14} />
              Agent instructions
              <span className="chip accent"><span className="dot" />Steers every draft</span>
            </h3>
            <button className="btn sm" onClick={() => editing ? saveInstructions() : setEditing(true)} disabled={savingInstr || unauth}>
              <Icon name={editing ? 'check' : 'edit'} size={11} /> {editing ? (savingInstr ? 'Saving…' : 'Save') : 'Edit'}
            </button>
          </div>
          <div className="card-body">
            {editing ? (
              <>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  style={{ width: '100%', minHeight: 110, border: '1px solid var(--accent)', borderRadius: 8, padding: 12, fontSize: 13, lineHeight: 1.55, background: 'var(--bg)', resize: 'vertical', outline: 'none', boxShadow: '0 0 0 3px var(--accent-soft)', fontFamily: 'var(--sans)' }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  {['Be more punchy', 'Match newsletter tone', 'Add data citations', 'Avoid jargon', 'More questions'].map((p) => (
                    <span key={p} className="prompt-chip" onClick={() => setInstructions(instructions + ' ' + p + '.')}>
                      <Icon name="plus" size={10} /> {p}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-2)', padding: 12, background: 'var(--bg-sunk)', borderRadius: 8, borderLeft: '2px solid var(--accent)' }}>
                {instructions || 'No instructions yet. Click Edit to write a style guide for the agent.'}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 11.5, color: 'var(--ink-3)' }}>
              <span className="mono">{instructions.length} chars</span>
              {settings?.lastRunAt && (
                <span className="mono">Last run: {relTime(settings.lastRunAt)}</span>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="chat" size={14} />
              Agent activity
              <span className="chip live"><span className="dot" />Live</span>
            </h3>
            <span className="meta">Last 24 hours</span>
          </div>
          <div className="card-body" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {feed.map((a) => {
              const meta = KIND_LABEL[a.kind] ?? { label: a.kind, tone: '' as const };
              return (
                <div className="agent-card" key={a.id}>
                  <div className="agent-mark">A</div>
                  <div>
                    <div className="agent-meta">
                      <span>Agent</span>
                      <span style={{ color: 'var(--ink-4)' }}>·</span>
                      <span>{relTime(a.createdAt)}</span>
                      <span className={`chip ${meta.tone}`}><span className="dot" />{meta.label}</span>
                    </div>
                    <div className="agent-title">{a.title}</div>
                    {a.body && <div className="agent-body">{a.body}</div>}
                  </div>
                </div>
              );
            })}
            {feed.length === 0 && (
              <div style={{ padding: 14, fontSize: 13, color: 'var(--ink-3)' }}>No activity yet. Enable autopilot to start drafting.</div>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3><Icon name="settings" size={14} /> Guardrails</h3>
          </div>
          <div className="card-body flush">
            {[
              { label: 'Post cadence', value: `${cadence} / week`, key: 'cadence' as const, options: [2, 3, 4, 5, 7] },
              { label: 'Auto-publish if score', value: `≥ ${threshold} / 100`, key: 'threshold' as const, options: [80, 85, 90, 95] },
              { label: 'Brand-safe filter', value: strict ? 'Strict' : 'Standard', key: 'strict' as const, options: [true, false] },
            ].map((row) => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{row.label}</span>
                <select
                  value={String(row.key === 'cadence' ? cadence : row.key === 'threshold' ? threshold : strict)}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (row.key === 'cadence') { setCadence(parseInt(v)); updateField({ cadencePerWeek: parseInt(v) }); }
                    else if (row.key === 'threshold') { setThreshold(parseInt(v)); updateField({ autoPublishThreshold: parseInt(v) }); }
                    else { const b = v === 'true'; setStrict(b); updateField({ brandSafetyStrict: b }); }
                  }}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink)', background: 'transparent', border: 'none', textAlign: 'right' }}
                  disabled={unauth}
                >
                  {row.options.map((o) => (
                    <option key={String(o)} value={String(o)}>
                      {row.key === 'cadence' ? `${o} / week` : row.key === 'threshold' ? `≥ ${o}` : (o ? 'Strict' : 'Standard')}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' }}>
              <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>Quiet hours</span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink)' }}>
                {settings?.quietHours?.start ?? '22:00'} – {settings?.quietHours?.end ?? '07:00'}
              </span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3><Icon name="globe" size={14} /> Niches I&apos;m watching</h3>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {niches.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                No niches selected yet. Set them in <a href="/onboarding" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>onboarding</a>.
              </div>
            )}
            {niches.map((n) => (
              <div key={n} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: 'var(--bg-sunk)' }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 500 }}>{NICHE_LABELS[n]}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>RSS + community signals</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentPage;
