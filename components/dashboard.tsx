'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Icon, Pglyph } from './icons';
import { apiDelete, apiPost, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../lib/ui/platforms';
import { healthFor, toneColor } from '../lib/ui/health';
import { activityMeta } from '../lib/ui/activity';
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
  // Health fields. /api/accounts has always returned these; leaving them off
  // this type is why the dashboard called a dead account "Live".
  tokenExpiresAt: string | null;
  autoRefresh: boolean;
  lastRefreshError: string | null;
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
type PublishedPost = {
  id: string;
  platformPostId: string | null;
  url: string | null;
  text: string;
  publishedAt: string | null;
  engagement: { likes?: number; comments?: number; shares?: number; lastSyncedAt?: string };
};

interface DashboardProps {
  onCompose: () => void;
  onEditDraft?: (id: string) => void;
}

const Dashboard: React.FC<DashboardProps> = ({ onCompose, onEditDraft }) => {
  const [tab, setTab] = useState<'upcoming' | 'drafts' | 'posted'>('upcoming');
  // Ticking "now" so token-expiry math stays pure during render and matches
  // the server render on hydration. Same pattern as the Connections page.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // `error` matters as much as `data`: a 500 used to render as "you have
  // nothing yet", which is a different and much worse thing to tell someone.
  const { data: scheduled, error: scheduledError, unauth } = useApi<ScheduledRow[]>('/api/schedule');
  const { data: drafts, error: draftsError } = useApi<DraftRow[]>('/api/drafts');
  const { data: trends, error: trendsError } = useApi<TrendRow[]>('/api/trends?limit=5');
  const { data: accounts, error: accountsError, mutate: refetchAccounts } = useApi<AccountRow[]>('/api/accounts');
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  // In-app confirm (replaces native confirm()) — consistent with .modal-sheet.
  const [confirmDisconnect, setConfirmDisconnect] = useState<AccountRow | null>(null);
  const disconnect = async (id: string) => {
    setDisconnecting(id);
    setDisconnectError(null);
    try {
      await apiDelete(`/api/accounts/${id}`);
      await refetchAccounts();
      setConfirmDisconnect(null);
    } catch (e) {
      setDisconnectError(friendlyApiError(e));
    } finally {
      setDisconnecting(null);
    }
  };
  const { data: activity } = useApi<ActivityRow[]>('/api/activity?limit=8');
  const fbConnected = !!accounts?.find((a) => a.platform === 'facebook' && !a.isStub);
  const { data: facebookMe } = useApi<FacebookMe>(fbConnected ? '/api/platforms/facebook/me' : null);
  const { data: insightsData, mutate: refetchInsights } = useApi<{ posts: PublishedPost[] }>(
    fbConnected ? '/api/platforms/facebook/insights' : null,
  );
  const [syncingInsights, setSyncingInsights] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncInsights = async () => {
    setSyncingInsights(true);
    setSyncError(null);
    try {
      await apiPost('/api/platforms/facebook/insights', {});
      await refetchInsights();
    } catch (e) {
      setSyncError(friendlyApiError(e));
    } finally {
      setSyncingInsights(false);
    }
  };

  // Each tab depends on ONE query. Gating all three on `scheduled && drafts`
  // meant a single failing endpoint blanked tabs that had nothing to do with it.
  const tabQuery = tab === 'drafts'
    ? { data: drafts, error: draftsError, label: 'drafts' }
    : { data: scheduled, error: scheduledError, label: 'posts' };

  const queueRows = useMemo(() => {
    if (tab === 'drafts' ? !drafts : !scheduled) return null;
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

  const showQueue = queueRows ?? [];
  const showTrends = (trends ?? []).slice(0, 5).map((t, i) => ({
    rank: i + 1,
    title: t.title,
    vol: t.score ? `${t.score}` : '—',
    delta: t.source ?? 'fresh',
    niche: t.niche,
    sourceUrl: t.source,
  }));

  const realConnected = (accounts ?? []).filter((a) => !a.isStub).length;
  const totalConnected = (accounts ?? []).length;

  const pendingCount = (scheduled ?? []).filter((s) => s.status === 'pending').length;
  const pendingConnected = totalConnected - realConnected;

  // A failed query has no number to show. "0" is a lie; "—" is not.
  const stats = [
    {
      label: 'Scheduled (pending)',
      value: scheduledError ? '—' : String(pendingCount),
      hint: scheduledError ? "couldn't load" : 'awaiting publish',
    },
    {
      label: 'Drafts in queue',
      value: draftsError ? '—' : String((drafts ?? []).filter((d) => d.status === 'draft').length),
      hint: draftsError ? "couldn't load" : 'not yet scheduled',
    },
    {
      label: 'Trends watching',
      value: trendsError ? '—' : String((trends ?? []).length),
      hint: trendsError ? "couldn't load" : 'in your niches',
    },
    {
      label: 'Connected platforms',
      value: accountsError ? '—' : String(realConnected),
      hint: accountsError
        ? "couldn't load"
        : pendingConnected > 0
        ? `${realConnected} live · ${pendingConnected} pending`
        : `${realConnected} live`,
    },
  ];

  const needsReconnect = (accounts ?? []).filter(
    (a) => !a.isStub && healthFor(a, now).tone === 'bad',
  );

  return (
    <>
      <div className="briefing">
        <div>
          {/* suppressHydrationWarning: current time + locale/timezone formatting
              differ between the server render and the client, which is a benign
              text mismatch we don't want escalating to a hydration error. */}
          <div className="briefing-eyebrow" suppressHydrationWarning>
            <span className="pulse" />
            Morning briefing · {new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
          <h2>
            {scheduledError
              ? <>I couldn&apos;t load your queue. <em>This is a problem on our side, not an empty queue — retry in a moment.</em></>
              : (scheduled ?? []).filter((s) => s.status === 'pending').length > 0
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
          <div className="meter-tiny">Your queue</div>
          <div className="meter-row"><span>Scheduled (pending)</span><strong>{pendingCount}</strong></div>
          <div className="meter-row"><span>Drafts in queue</span><strong>{(drafts ?? []).filter((d) => d.status === 'draft').length}</strong></div>
          <div className="meter-divider" />
          <div className="meter-tiny">Best windows today</div>
          <div style={{ fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.5 }}>
            Posting-time insights are coming soon — they&apos;ll surface here once we have enough of your engagement data.
          </div>
        </div>
      </div>

      <div className="stat-grid">
        {stats.map((s) => (
          <div className="stat" key={s.label}>
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{s.value}</div>
            <div className="stat-delta" style={{ color: 'var(--ink-4)' }}>{s.hint}</div>
          </div>
        ))}
      </div>

      {/* A dead connection is the loudest thing on this page, because publishing
          to it fails 401 forever and nothing else here would say so. */}
      {needsReconnect.length > 0 && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
            padding: '12px 16px', borderRadius: 10,
            border: '1px solid var(--bad)', background: 'var(--bg-elev)',
            borderLeft: '4px solid var(--bad)',
          }}
        >
          <Icon name="bolt" size={14} style={{ color: 'var(--bad)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5 }}>
            <strong>
              {needsReconnect.length === 1
                ? `Your ${needsReconnect[0].platform} connection needs reconnecting.`
                : `${needsReconnect.length} connections need reconnecting.`}
            </strong>{' '}
            <span style={{ color: 'var(--ink-3)' }}>
              Scheduled posts to {needsReconnect.length === 1 ? 'it' : 'them'} will keep failing until you do.
            </span>
          </div>
          <a className="btn sm" href="/dashboard?tab=connections" style={{ flexShrink: 0, textDecoration: 'none' }}>
            Reconnect
          </a>
        </div>
      )}

      {accountsError && (
        <ErrorNote what="your connected accounts" style={{ marginBottom: 16 }} />
      )}

      {facebookMe && !facebookMe.stub && (
        <FacebookPageCard data={facebookMe} />
      )}

      {fbConnected && (
        <QuickPost platform="facebook" pageName={facebookMe?.page.name} />
      )}

      <BrandMonitor />


      {fbConnected && insightsData && insightsData.posts.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h3>
              <Icon name="chart" size={14} /> Your post performance
              <span className="chip ghost mono">{insightsData.posts.length}</span>
            </h3>
            <button className="btn sm" onClick={syncInsights} disabled={syncingInsights}>
              <Icon name="refresh" size={11} /> {syncingInsights ? 'Syncing…' : 'Sync from Facebook'}
            </button>
          </div>
          {syncError && (
            <div style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--bad)', borderBottom: '1px solid var(--line)' }}>
              {syncError}
            </div>
          )}
          <div className="card-body flush">
            {insightsData.posts.slice(0, 8).map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, lineHeight: 1.45, color: 'var(--ink-2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {p.text || '(no caption)'}
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 4 }}>
                    {p.publishedAt && new Date(p.publishedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {p.engagement.lastSyncedAt && <> · synced {relTime(p.engagement.lastSyncedAt)}</>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--ink-2)', flexShrink: 0 }} className="mono">
                  <span>♡ {p.engagement.likes ?? 0}</span>
                  <span>💬 {p.engagement.comments ?? 0}</span>
                  <span>↻ {p.engagement.shares ?? 0}</span>
                </div>
                {p.url && (
                  <a className="btn sm ghost" href={p.url} target="_blank" rel="noreferrer" style={{ flexShrink: 0 }}>
                    <Icon name="arrow_right" size={11} /> View
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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
            {showQueue.map((q) => {
              const editable = tab === 'drafts' && !!onEditDraft;
              return (
              <div
                className="queue-item"
                key={q.id}
                role={editable ? 'button' : undefined}
                tabIndex={editable ? 0 : undefined}
                style={editable ? { cursor: 'pointer' } : undefined}
                onClick={editable ? () => onEditDraft!(q.id) : undefined}
                onKeyDown={editable ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEditDraft!(q.id); }
                } : undefined}
              >
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
                      <a className="chip ghost mono" href={q.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
                        <Icon name="arrow_right" size={10} /> View
                      </a>
                    )}
                  </div>
                </div>
                <div className="queue-actions" onClick={(e) => e.stopPropagation()}>
                  {editable && (
                    <button className="icon-btn" title="Edit" onClick={() => onEditDraft!(q.id)}><Icon name="edit" size={13} /></button>
                  )}
                </div>
              </div>
            );
            })}
            {/* An error is NOT an empty queue. Showing "nothing scheduled yet"
                after a 500 told users their posts had vanished. */}
            {showQueue.length === 0 && tabQuery.error && (
              <ErrorNote what={`your ${tabQuery.label}`} />
            )}
            {showQueue.length === 0 && !tabQuery.error && (
              <div style={{ padding: 28, fontSize: 13, color: 'var(--ink-3)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <Icon name="clock" size={18} style={{ color: 'var(--ink-4)' }} />
                <div style={{ maxWidth: 320, lineHeight: 1.5 }}>
                  {tab === 'upcoming' && 'No scheduled posts yet. Use Compose to draft one, then Schedule.'}
                  {tab === 'drafts' && 'No drafts yet. Compose a post or run the agent to auto-draft.'}
                  {tab === 'posted' && "No published posts yet. Once you publish, they'll show up here."}
                </div>
                <button className="btn primary" onClick={onCompose}>
                  <Icon name="sparkle" size={12} /> Open Compose
                </button>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3>
                <Icon name="fire" size={14} /> Trending in your niche
              </h3>
              <span className="meta">Live · HN + dev.to + Reddit</span>
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
              {showTrends.length === 0 && (trendsError ? (
                <ErrorNote what="your trends" />
              ) : (
                <div style={{ padding: 18, fontSize: 13, color: 'var(--ink-3)' }}>
                  No trends yet. Auto-pilot → <strong>Pull fresh trends</strong>.
                </div>
              ))}
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
                    <span className={`chip ${activityMeta(a.kind).tone}`} style={{ marginTop: 2, flexShrink: 0 }}>
                      <span className="dot" />{activityMeta(a.kind).label}
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
                {accounts.map((a) => {
                  // Same helper the Connections page uses, so the two screens
                  // can't describe the same account differently.
                  const health = healthFor(a, now);
                  return (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                    <Pglyph p={PLATFORM_TO_SHORT[a.platform]} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {a.displayName || a.meta?.pageName || a.handle || a.platform}
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                        {a.handle ? `@${a.handle}` : a.platform}
                        {a.isStub && <> · stub</>}
                        {health.tone === 'bad' && <> · {health.detail}</>}
                      </div>
                    </div>
                    <span
                      className="chip"
                      title={health.detail}
                      style={health.tone === 'bad' || health.tone === 'warn'
                        ? { color: toneColor[health.tone], borderColor: toneColor[health.tone] }
                        : undefined}
                    >
                      <span className="dot" style={{ background: toneColor[health.tone] }} />
                      {health.label}
                    </span>
                    <button
                      className="icon-btn"
                      title="Disconnect"
                      onClick={() => setConfirmDisconnect(a)}
                      disabled={disconnecting === a.id}
                      style={{ marginLeft: 4 }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmDisconnect && (
        <div className="modal-scrim" onClick={() => { if (!disconnecting) { setDisconnectError(null); setConfirmDisconnect(null); } }}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ width: 'min(420px, 92vw)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 15, letterSpacing: '-0.01em' }}>Disconnect this account?</h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
              {confirmDisconnect.displayName || confirmDisconnect.meta?.pageName || confirmDisconnect.handle || confirmDisconnect.platform} will be disconnected. You can reconnect anytime.
            </p>
            {disconnectError && (
              <p style={{ margin: '0 0 16px', padding: '8px 10px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--bad)', border: '1px solid var(--bad)', borderRadius: 8 }}>
                {disconnectError}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => { setDisconnectError(null); setConfirmDisconnect(null); }} disabled={!!disconnecting}>Keep connected</button>
              <button className="btn primary" onClick={() => disconnect(confirmDisconnect.id)} disabled={!!disconnecting}>
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

/**
 * "We couldn't load this" — deliberately NOT shaped like the empty state.
 * Red rule, no "get started" call to action, and an explicit retry.
 */
const ErrorNote: React.FC<{ what: string; style?: React.CSSProperties }> = ({ what, style }) => (
  <div
    style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '14px 16px', fontSize: 13, lineHeight: 1.5,
      background: 'var(--bg-elev)', borderLeft: '3px solid var(--bad)',
      ...style,
    }}
  >
    <Icon name="bolt" size={14} style={{ color: 'var(--bad)', flexShrink: 0 }} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <strong>Couldn&apos;t load {what}.</strong>{' '}
      <span style={{ color: 'var(--ink-3)' }}>Something went wrong on our side — this isn&apos;t an empty list.</span>
    </div>
    <button className="btn sm" onClick={() => window.location.reload()} style={{ flexShrink: 0 }}>
      <Icon name="refresh" size={11} /> Retry
    </button>
  </div>
);

type BrandReport = {
  summary: string;
  mentions: Array<{ source: string; url: string; sentiment: 'positive' | 'neutral' | 'negative'; snippet: string }>;
  competitorMoves: Array<{ competitor: string; what: string; url: string | null }>;
  respondWith: Array<{ angle: string; draftText: string }>;
};

const BrandMonitor: React.FC = () => {
  const [brand, setBrand] = useState('');
  const [competitors, setCompetitors] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BrandReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!brand.trim()) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const body = {
        brand: brand.trim(),
        competitors: competitors.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8),
      };
      const r = await apiPost<{ ok: boolean; report: BrandReport }>('/api/agent/brand-monitor', body);
      setReport(r.report);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.startsWith('429') ? 'Slow down — limit is 3 every 5 min.' : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h3>
          <Icon name="search" size={14} /> Brand monitor
          <span className="chip ghost mono">web search</span>
        </h3>
        <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>Agent searches recent public mentions and suggests replies.</span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={brand}
            placeholder="Your brand (e.g. Sociafy)"
            onChange={(e) => setBrand(e.target.value)}
            style={{ flex: '2 1 220px', minWidth: 0, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg)', fontSize: 13 }}
          />
          <input
            type="text"
            value={competitors}
            placeholder="Competitors (comma-separated, optional)"
            onChange={(e) => setCompetitors(e.target.value)}
            style={{ flex: '2 1 240px', minWidth: 0, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg)', fontSize: 13 }}
          />
          <button className="btn primary" onClick={run} disabled={busy || !brand.trim()}>
            {busy ? <><Icon name="refresh" size={12} /> Searching</> : <><Icon name="globe" size={12} /> Scan</>}
          </button>
        </div>
        {error && <div style={{ fontSize: 12, color: 'var(--bad)' }}>{error}</div>}
        {report && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink)' }}>{report.summary}</p>
            {report.mentions.length > 0 && (
              <div>
                <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>Recent mentions</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>
                  {report.mentions.slice(0, 5).map((m, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>
                      <span style={{ color: m.sentiment === 'positive' ? 'var(--good)' : m.sentiment === 'negative' ? 'var(--bad)' : 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 10, marginRight: 6 }}>{m.sentiment}</span>
                      <a href={m.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-ink)', textDecoration: 'underline' }}>{m.source}</a>
                      <span style={{ color: 'var(--ink-3)' }}> — {m.snippet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.respondWith.length > 0 && (
              <div>
                <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>Suggested replies</div>
                {report.respondWith.slice(0, 3).map((r, i) => (
                  <div key={i} style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg-sunk)', marginBottom: 6 }}>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginBottom: 4 }}>{r.angle}</div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{r.draftText}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
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
    <div className="card-body m-stack" style={{ display: 'grid', gridTemplateColumns: data.recentPosts.length > 0 ? '1fr 1fr 1fr' : '1fr', gap: 12 }}>
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
