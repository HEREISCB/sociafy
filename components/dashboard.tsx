'use client';

import React, { useMemo, useState } from 'react';
import { Icon, Pglyph, Spark } from './icons';
import { apiDelete, apiPost, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';

type ScheduledRow = {
  id: string;
  platform: Platform;
  scheduledAt: string;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';
  text: string;
  platformPostUrl?: string | null;
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
type AccountRow = {
  id: string;
  platform: Platform;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isStub: boolean;
  meta: { pageName?: string; pageId?: string } | null;
};
type ActivityRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  createdAt: string;
};
type FacebookMe = {
  stub: boolean;
  page: { id: string; name: string; username: string | null; avatarUrl: string | null; link: string | null; about: string | null; category: string | null };
  followerCount: number;
  recentPosts: Array<{
    id: string;
    message: string;
    createdAt: string;
    url: string | null;
    image: string | null;
    likes: number;
    comments: number;
    shares: number;
  }>;
};

const DEMO_QUEUE = [
  { id: 'demo-1', when: 'Today', time: '14:30', text: "The 3 metrics every solo founder should ignore (and the one you can't). A thread →", platforms: ['x', 'li'], status: 'scheduled', score: 92 },
  { id: 'demo-2', when: 'Today', time: '18:00', text: 'Behind the scenes of our new studio setup.', platforms: ['ig', 'fb'], status: 'ai', score: 88 },
  { id: 'demo-3', when: 'Tomorrow', time: '09:15', text: 'Hot take: most personal branding advice is just polished gatekeeping.', platforms: ['li', 'x'], status: 'draft', score: 76 },
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
  const { data: accounts, mutate: refetchAccounts } = useApi<AccountRow[]>('/api/accounts');
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const disconnect = async (id: string) => {
    if (!confirm('Disconnect this account? You can reconnect anytime.')) return;
    setDisconnecting(id);
    try {
      await apiDelete(`/api/accounts/${id}`);
      await refetchAccounts();
    } finally {
      setDisconnecting(null);
    }
  };
  const { data: activity } = useApi<ActivityRow[]>('/api/activity?limit=8');
  const fbConnected = !!accounts?.find((a) => a.platform === 'facebook' && !a.isStub);
  const { data: facebookMe } = useApi<FacebookMe>(fbConnected ? '/api/platforms/facebook/me' : null);

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
          url: null as string | null,
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
          url: null,
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
        url: s.platformPostUrl ?? null,
      }));
  }, [scheduled, drafts, tab]);

  const showQueue = queueRows && queueRows.length > 0 ? queueRows : DEMO_QUEUE.map((q) => ({ ...q, url: null as string | null }));
  const usingDemoQueue = !queueRows || queueRows.length === 0;
  const showTrends = (trends && trends.length > 0)
    ? trends.slice(0, 5).map((t, i) => ({
        rank: i + 1,
        title: t.title,
        vol: t.score ? `${t.score}` : '—',
        delta: t.source ?? 'fresh',
        niche: t.niche,
      }))
    : DEMO_TRENDS;
  const usingDemoTrends = !trends || trends.length === 0;

  const realConnected = (accounts ?? []).filter((a) => !a.isStub).length;
  const totalConnected = (accounts ?? []).length;

  const stats = [
    {
      label: 'Scheduled this week',
      value: String((scheduled ?? []).filter((s) => s.status === 'pending').length),
      delta: 'live',
      up: true,
      spark: [4, 6, 5, 8, 7, 9, 11, 12, 14],
    },
    {
      label: 'Drafts in queue',
      value: String((drafts ?? []).filter((d) => d.status === 'draft').length),
      delta: 'live',
      up: true,
      spark: [3, 4, 3, 6, 5, 7, 6, 9, 8],
    },
    {
      label: 'Trends watching',
      value: String((trends ?? []).length),
      delta: 'live',
      up: true,
      spark: [80, 90, 85, 110, 105, 125, 120, 135, 142],
    },
    {
      label: 'Connected platforms',
      value: `${realConnected}${totalConnected > realConnected ? ` (+${totalConnected - realConnected} stub)` : ''}`,
      delta: 'live',
      up: true,
      spark: [40, 45, 50, 55, 52, 58, 60, 62, 64],
    },
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
            {(scheduled ?? []).filter((s) => s.status === 'pending').length > 0
              ? <><strong>{(scheduled ?? []).filter((s) => s.status === 'pending').length}</strong> posts queued for the coming days. <em>Open compose to draft another angle.</em></>
              : trends && trends.length > 0
                ? <>I&apos;m watching <strong>{trends.length}</strong> trends in your niches. <em>Open compose to draft an angle.</em></>
                : <>Nothing queued yet. <em>Open compose to write your first post.</em></>}
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
          </div>
        </div>
        <div className="briefing-meter">
          <div className="meter-tiny">Today&apos;s posting plan</div>
          <div className="meter-row"><span>Posts queued</span><strong>{(scheduled ?? []).filter((s) => s.status === 'pending').length} / 7</strong></div>
          <div className="meter-bar"><div className="fill" style={{ width: `${Math.min(100, (((scheduled ?? []).filter((s) => s.status === 'pending').length) / 7) * 100)}%` }} /></div>
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

      {facebookMe && !facebookMe.stub && (
        <FacebookPageCard data={facebookMe} />
      )}

      {fbConnected && (
        <QuickPost platform="facebook" pageName={facebookMe?.page.name} />
      )}

      <div className="two-col">
        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="clock" size={14} />
              Posting queue
              <span className="chip live"><span className="dot" />Live</span>
              {usingDemoQueue && <span className="chip ghost mono">demo</span>}
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
                    {q.url && (
                      <a className="chip ghost mono" href={q.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                        <Icon name="arrow_right" size={10} /> View
                      </a>
                    )}
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
              <h3>
                <Icon name="fire" size={14} /> Trending in your niche
                {usingDemoTrends && <span className="chip ghost mono">demo</span>}
              </h3>
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

          {activity && activity.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3><Icon name="chat" size={14} /> Recent activity</h3>
                <span className="chip live"><span className="dot" />Live</span>
              </div>
              <div className="card-body flush">
                {activity.slice(0, 6).map((a) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
                    <span className={`chip ${activityTone(a.kind)}`} style={{ marginTop: 2, flexShrink: 0 }}>
                      <span className="dot" />{activityLabel(a.kind)}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.4 }}>{a.title}</div>
                      {a.body && (
                        <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.body}</div>
                      )}
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 4 }}>{relTime(a.createdAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {accounts && accounts.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3><Icon name="globe" size={14} /> Connected accounts</h3>
                <span className="meta">{realConnected} live</span>
              </div>
              <div className="card-body flush">
                {accounts.map((a) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                    <Pglyph p={PLATFORM_TO_SHORT[a.platform]} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {a.displayName || a.meta?.pageName || a.handle || a.platform}
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                        {a.handle ? `@${a.handle}` : a.platform}
                        {a.isStub && <> · stub</>}
                      </div>
                    </div>
                    {a.isStub
                      ? <span className="chip ghost mono">stub</span>
                      : <span className="chip"><span className="dot" style={{ background: 'var(--good)' }} />Live</span>}
                    <button
                      className="icon-btn"
                      title="Disconnect"
                      onClick={() => disconnect(a.id)}
                      disabled={disconnecting === a.id}
                      style={{ marginLeft: 4 }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

const QuickPost: React.FC<{ platform: Platform; pageName?: string }> = ({ platform, pageName }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; url?: string | null; error?: string } | null>(null);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const draft = await apiPost<{ id: string }>('/api/drafts', {
        body: text,
        targetPlatforms: [platform],
        source: 'user',
      });
      const r = await apiPost<{ results: Array<{ platform: string; ok: boolean; url?: string | null; error?: string }> }>(
        '/api/publish',
        { draftId: draft.id, platforms: [platform] },
      );
      const out = r.results[0];
      setResult(out);
      if (out?.ok) setText('');
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h3>
          <Icon name="sparkle" size={14} />
          Quick post {pageName ? <span className="meta">→ {pageName}</span> : null}
        </h3>
        <span className="chip ghost mono">{text.length} chars</span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a post and hit Publish — it goes live to your Facebook Page in seconds."
          rows={3}
          style={{
            width: '100%',
            padding: 12,
            border: '1px solid var(--line-2)',
            borderRadius: 10,
            fontSize: 14,
            background: 'var(--bg)',
            color: 'var(--ink)',
            fontFamily: 'inherit',
            resize: 'vertical',
            outline: 'none',
            lineHeight: 1.5,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {result && (
            result.ok
              ? <span className="chip" style={{ color: 'var(--good)' }}><span className="dot" style={{ background: 'var(--good)' }} />Published{result.url ? <> · <a href={result.url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)', textDecoration: 'underline' }}>View on Facebook</a></> : null}</span>
              : <span className="chip warn"><span className="dot" />{result.error}</span>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={send} disabled={busy || !text.trim()}>
            {busy ? <><Icon name="refresh" size={12} /> Publishing</> : <><Icon name="send" size={12} /> Publish now</>}
          </button>
        </div>
      </div>
    </div>
  );
};

const FacebookPageCard: React.FC<{ data: FacebookMe }> = ({ data }) => (
  <div className="card" style={{ marginBottom: 16 }}>
    <div className="card-head">
      <h3>
        <Pglyph p="fb" />
        {data.page.name}
        {data.page.category && <span className="chip ghost mono">{data.page.category}</span>}
      </h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="meta mono">{data.followerCount.toLocaleString()} followers</span>
        {data.page.link && (
          <a className="btn sm ghost" href={data.page.link} target="_blank" rel="noreferrer">
            <Icon name="arrow_right" size={11} /> Page
          </a>
        )}
      </div>
    </div>
    <div className="card-body" style={{ display: 'grid', gridTemplateColumns: data.recentPosts.length > 0 ? '1fr 1fr 1fr' : '1fr', gap: 12 }}>
      {data.recentPosts.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
          No posts on this Page yet. Use Compose → Post Now to publish your first.
        </div>
      ) : (
        data.recentPosts.slice(0, 3).map((p) => (
          <a
            key={p.id}
            href={p.url ?? '#'}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
              border: '1px solid var(--line)', borderRadius: 10,
              background: 'var(--bg-sunk)', textDecoration: 'none', color: 'inherit',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--ink-3)' }} className="mono">
              {new Date(p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {p.message || '(no caption)'}
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--ink-3)' }} className="mono">
              <span>♡ {p.likes}</span>
              <span>💬 {p.comments}</span>
              <span>↻ {p.shares}</span>
            </div>
          </a>
        ))
      )}
    </div>
  </div>
);

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

function activityLabel(kind: string): string {
  switch (kind) {
    case 'platform_connected': return 'Connected';
    case 'platform_disconnected': return 'Disconnected';
    case 'draft_created': return 'Draft';
    case 'draft_scheduled': return 'Scheduled';
    case 'manual_publish': return 'Published';
    case 'auto_publish': return 'Auto-publish';
    case 'publish_failed': return 'Failed';
    case 'agent_drafted': return 'Agent draft';
    case 'agent_held': return 'Held';
    case 'agent_enabled': return 'Agent on';
    case 'agent_disabled': return 'Agent off';
    case 'trend_spotted': return 'Trend';
    default: return kind;
  }
}

function activityTone(kind: string): 'accent' | 'warn' | '' {
  if (kind === 'publish_failed' || kind === 'agent_held') return 'warn';
  if (kind === 'manual_publish' || kind === 'auto_publish' || kind === 'platform_connected') return 'accent';
  return '';
}

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
