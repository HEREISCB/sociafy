'use client';

import React, { useMemo, useState } from 'react';
import { Icon, Pglyph, Spark } from './icons';
import { useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';

type ScheduledRow = {
  id: string;
  platform: Platform;
  scheduledAt: string;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';
  text: string;
};
type DraftRow = {
  id: string;
  body: string;
  status: 'draft' | 'scheduled' | 'published' | 'archived';
  targetPlatforms: Platform[];
  variants?: Array<{ score?: number }>;
  source: 'user' | 'agent';
  updatedAt: string;
};
type TrendRow = {
  id: string;
  niche: string;
  title: string;
  summary: string | null;
  source: string | null;
  score: number;
  capturedAt: string;
};

const DEMO_QUEUE = [
  { id: 'demo-1', when: 'Today', time: '14:30', text: "The 3 metrics every solo founder should ignore (and the one you can't). A thread →", platforms: ['x', 'li'], status: 'scheduled', score: 92 },
  { id: 'demo-2', when: 'Today', time: '18:00', text: 'Behind the scenes of our new studio setup.', platforms: ['ig', 'fb'], status: 'ai', score: 88 },
  { id: 'demo-3', when: 'Tomorrow', time: '09:15', text: "Hot take: most personal branding advice is just polished gatekeeping.", platforms: ['li', 'x'], status: 'draft', score: 76 },
];

const DEMO_TRENDS = [
  { rank: 1, title: 'Rise of "agentic content" workflows', vol: '24.1k', delta: '+312%', niche: 'Marketing' },
  { rank: 2, title: '#BuildInPublic resurgence on LinkedIn', vol: '18.7k', delta: '+148%', niche: 'Founders' },
  { rank: 3, title: 'Vertical video gets a comeback on X', vol: '12.3k', delta: '+96%', niche: 'Creator' },
];

interface DashboardProps {
  mode: string;
  onCompose: () => void;
}

const Dashboard: React.FC<DashboardProps> = ({ onCompose }) => {
  const [tab, setTab] = useState<'upcoming' | 'drafts' | 'posted'>('upcoming');

  const { data: scheduled, unauth } = useApi<ScheduledRow[]>('/api/schedule');
  const { data: drafts } = useApi<DraftRow[]>('/api/drafts');
  const { data: trends } = useApi<TrendRow[]>('/api/trends?limit=5');

  const queueRows = useMemo(() => {
    if (!scheduled || !drafts) return null;
    if (tab === 'upcoming') {
      return (scheduled ?? [])
        .filter((s) => s.status === 'pending' || s.status === 'publishing')
        .sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt))
        .slice(0, 8)
        .map((s) => ({
          id: s.id,
          when: relWhen(s.scheduledAt),
          time: hhmm(s.scheduledAt),
          text: s.text,
          platforms: [PLATFORM_TO_SHORT[s.platform]],
          status: 'scheduled' as const,
          score: 0,
        }));
    }
    if (tab === 'drafts') {
      return (drafts ?? [])
        .filter((d) => d.status === 'draft')
        .slice(0, 8)
        .map((d) => ({
          id: d.id,
          when: relWhen(d.updatedAt),
          time: hhmm(d.updatedAt),
          text: d.body || '(empty draft)',
          platforms: d.targetPlatforms.map((p) => PLATFORM_TO_SHORT[p]),
          status: d.source === 'agent' ? ('ai' as const) : ('draft' as const),
          score: d.variants?.[0]?.score ?? 0,
        }));
    }
    return (scheduled ?? [])
      .filter((s) => s.status === 'published')
      .sort((a, b) => +new Date(b.scheduledAt) - +new Date(a.scheduledAt))
      .slice(0, 8)
      .map((s) => ({
        id: s.id,
        when: relWhen(s.scheduledAt),
        time: hhmm(s.scheduledAt),
        text: s.text,
        platforms: [PLATFORM_TO_SHORT[s.platform]],
        status: 'scheduled' as const,
        score: 0,
      }));
  }, [scheduled, drafts, tab]);

  const showQueue = queueRows && queueRows.length > 0 ? queueRows : DEMO_QUEUE;
  const showTrends = (trends && trends.length > 0)
    ? trends.slice(0, 5).map((t, i) => ({
        rank: i + 1,
        title: t.title,
        vol: t.score ? `${t.score}` : '—',
        delta: '+rank',
        niche: t.niche,
      }))
    : DEMO_TRENDS;

  const stats = [
    { label: 'Scheduled this week', value: String((scheduled ?? []).filter((s) => s.status === 'pending').length || 14), delta: 'live', up: true, spark: [4, 6, 5, 8, 7, 9, 11, 12, 14] },
    { label: 'Drafts in queue', value: String((drafts ?? []).filter((d) => d.status === 'draft').length || 8), delta: 'live', up: true, spark: [3, 4, 3, 6, 5, 7, 6, 9, 8] },
    { label: 'Trends watching', value: String((trends ?? []).length || 5), delta: 'live', up: true, spark: [80, 90, 85, 110, 105, 125, 120, 135, 142] },
    { label: 'Connected platforms', value: '—', delta: '', up: true, spark: [40, 45, 50, 55, 52, 58, 60, 62, 64] },
  ];

  return (
    <>
      <div className="briefing">
        <div>
          <div className="briefing-eyebrow">
            <span className="pulse" />
            Morning briefing · {new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
          <h2>
            {trends && trends.length > 0
              ? <>I&apos;m watching {trends.length} trends in your niche. <em>Open compose to draft an angle.</em></>
              : <>Two trends in your niche are spiking this morning. <em>I drafted three posts for you to review.</em></>}
          </h2>
          <p>
            {unauth
              ? 'You\'re in demo mode. Sign in to wire this dashboard to your real queue, drafts, and trends.'
              : 'Cron jobs run every few minutes — scheduled posts publish to the platforms you\'ve connected. Adjust autopilot from the Auto-pilot tab.'}
          </p>
          <div className="briefing-actions">
            <button className="btn accent" onClick={onCompose}>
              <Icon name="sparkle" size={13} /> Compose
            </button>
            <a className="btn" href="/dashboard" onClick={(e) => { e.preventDefault(); }}>
              <Icon name="trend" size={13} /> See trends
            </a>
          </div>
        </div>
        <div className="briefing-meter">
          <div className="meter-tiny">Today&apos;s posting plan</div>
          <div className="meter-row"><span>Posts queued</span><strong>{(scheduled ?? []).filter((s) => s.status === 'pending').length || 4} / {7}</strong></div>
          <div className="meter-bar"><div className="fill" style={{ width: `${Math.min(100, (((scheduled ?? []).filter((s) => s.status === 'pending').length || 4) / 7) * 100)}%` }} /></div>
          <div className="meter-divider" />
          <div className="meter-tiny">Best windows today</div>
          <div className="meter-row mono"><span>X · 09:15</span><span>+34%</span></div>
          <div className="meter-row mono"><span>LinkedIn · 12:30</span><span>+28%</span></div>
          <div className="meter-row mono"><span>Instagram · 18:00</span><span>+19%</span></div>
        </div>
      </div>

      <div className="stat-grid">
        {stats.map((s) => (
          <div className="stat" key={s.label}>
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{s.value}</div>
            <div className={`stat-delta ${s.up ? 'up' : 'down'}`}>
              <Icon name={s.up ? 'arrow_up' : 'arrow_down'} size={11} />
              {s.delta}
            </div>
            <Spark data={s.spark} color="var(--ink-4)" />
          </div>
        ))}
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="clock" size={14} />
              Posting queue
              <span className="chip live"><span className="dot" />Live</span>
            </h3>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div className="mode-switch" style={{ padding: 2 }}>
                {(['upcoming', 'drafts', 'posted'] as const).map((t) => (
                  <span
                    key={t}
                    className={`opt ${tab === t ? 'active' : ''}`}
                    style={{ fontSize: 11, padding: '3px 10px' }}
                    onClick={() => setTab(t)}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </span>
                ))}
              </div>
              <button className="btn sm" onClick={onCompose}><Icon name="plus" size={12} /> New</button>
            </div>
          </div>
          <div className="card-body flush">
            {showQueue.map((q) => (
              <div className="queue-item" key={q.id}>
                <div className="queue-time">
                  <strong>{q.when}</strong>
                  {q.time}
                </div>
                <div className="queue-content">
                  <div className="queue-text">{q.text}</div>
                  <div className="queue-meta">
                    <div className="queue-platforms">
                      {q.platforms.map((p) => <Pglyph key={p} p={p} />)}
                    </div>
                    {q.status === 'ai' && <span className="chip accent"><span className="dot" />Agent draft</span>}
                    {q.status === 'scheduled' && <span className="chip"><span className="dot" style={{ background: 'var(--good)' }} />Scheduled</span>}
                    {q.status === 'draft' && <span className="chip"><span className="dot" />Draft</span>}
                    {q.score > 0 && <span className="chip ghost mono">Score {q.score}</span>}
                  </div>
                </div>
                <div className="queue-actions">
                  <button className="icon-btn" title="Edit"><Icon name="edit" size={13} /></button>
                  <button className="icon-btn" title="Reschedule"><Icon name="clock" size={13} /></button>
                  <button className="icon-btn" title="More"><Icon name="more" size={13} /></button>
                </div>
              </div>
            ))}
            {showQueue.length === 0 && (
              <div style={{ padding: 24, fontSize: 13, color: 'var(--ink-3)', textAlign: 'center' }}>
                Nothing in this tab yet. Try Compose →
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3><Icon name="fire" size={14} /> Trending in your niche</h3>
              <span className="meta">Hourly</span>
            </div>
            <div className="card-body flush">
              {showTrends.map((t) => (
                <div className="trend-item" key={t.rank}>
                  <span className="trend-rank tnum">{String(t.rank).padStart(2, '0')}</span>
                  <div>
                    <div className="trend-title">{t.title}</div>
                    <div className="trend-sub">
                      {t.niche} · {t.vol}{' '}
                      <span style={{ color: 'var(--good)' }}>{t.delta}</span>
                    </div>
                  </div>
                  <div className="trend-action">
                    <button className="btn sm" onClick={onCompose}><Icon name="sparkle" size={11} /> Draft</button>
                  </div>
                </div>
              ))}
              {showTrends.length === 0 && (
                <div style={{ padding: 18, fontSize: 13, color: 'var(--ink-3)' }}>
                  No trends yet — the trend monitor runs every hour.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

function relWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default Dashboard;
