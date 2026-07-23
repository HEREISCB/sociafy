'use client';

import React, { useState } from 'react';
import { Icon, Pglyph } from '../icons';
import { Sparkline } from '../spark';
import { useApi, apiPost, apiDelete, apiGet } from '../../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';

type FormatMix = { reel: number; carousel: number; image: number };
type Strategy = {
  doList: string[]; dontList: string[];
  plan: { frequency: string; bestDays: string[]; bestTimes: string[]; summary: string };
  audience: { estimate: string; basis: string };
} | null;

type Competitor = {
  id: string; handle: string; displayName: string | null; platform: string;
  isActive: boolean; notes: string | null;
  latestFollowers: number; latestEngagementRate: number;
  metrics: Array<{ date: string; followers: number | null; avgEngagementRate: number | null }>;
};

type Insights = {
  competitor: { id: string; handle: string; displayName: string | null; followers: number | null };
  latestEngagementRate: number;
  sampleSize: number;
  postsPerWeek: number; engagementTrend: number; followerGrowth: number;
  storiesPerDay: number; storiesToday: number; storiesTracked: boolean;
  formatMix: FormatMix;
  bestHours: Array<{ hour: number; avgEngagement: number; posts: number }>;
  bestTimes: Array<{ hour: string; avgEngagement: number; posts: number }>;
  bestDaysLabeled: Array<{ day: string; avgEngagement: number; posts: number }>;
  heatmap: Array<{ day: number; hour: number; count: number; eng: number }>;
  topThemes: Array<{ theme: string; posts: number; avgEngagement: number }>;
  hashtagStrategy: Array<{ tag: string; uses: number }>;
  topAudios: Array<{ title: string; uses: number }>;
  topHooks: string[];
  strategy: Strategy;
};

type LandscapeCard = {
  id: string; handle: string; displayName: string | null; followers: number | null;
  postsPerWeek: number; storiesPerDay: number; engagementTrend: number; followerGrowth: number;
  topBestHourUTC: number | null; topTheme: string | null; formatMix: FormatMix;
};
type Landscape = {
  competitors: LandscapeCard[];
  aggregate: {
    count: number; avgPostsPerWeek: number; avgStoriesPerDay: number;
    busiestHoursIST: Array<{ hour: number; count: number }>;
    whiteSpaceHoursIST: Array<{ hour: number; count: number }>;
    commonThemes: string[]; commonHashtags: string[];
  } | null;
  strategy: Strategy; niche: string | null; dow: string[];
};

// crisp inline SVG marks for post formats (consistent across OS/browser, unlike emoji)
const FmtIcon: React.FC<{ k: 'reel' | 'carousel' | 'image' }> = ({ k }) => {
  const common = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, style: { flexShrink: 0 } };
  if (k === 'reel') return (
    <svg {...common} aria-hidden><rect x="2" y="3" width="20" height="18" rx="3" /><path d="M2 8h20M8 3l2.5 5M14 3l2.5 5" /><path d="M10 12.5v4l4-2z" fill="currentColor" stroke="none" /></svg>
  );
  if (k === 'carousel') return (
    <svg {...common} aria-hidden><rect x="7" y="4" width="13" height="16" rx="2.5" /><path d="M4 7v10" /><path d="M2 9v6" opacity="0.55" /></svg>
  );
  return (
    <svg {...common} aria-hidden><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="8.5" cy="9" r="1.6" /><path d="M21 16l-5-5-7 7" /></svg>
  );
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// 12-hour IST labels — easier to read than 24h; hours are already IST buckets
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;

// 8 three-hour blocks (12a, 3a, … 9p) — a 7×8 grid reads far easier than 7×24
const BLOCK_LABELS = [0, 3, 6, 9, 12, 15, 18, 21].map(hourLabel);
const blockRange = (b: number) => `${hourLabel(b * 3)}–${hourLabel((b * 3 + 3) % 24)}`;

const Heatmap: React.FC<{ cells: Insights['heatmap'] }> = ({ cells }) => {
  // collapse hourly cells into day × 3-hour block
  const grid = new Map<string, number>();
  for (const c of cells) {
    const b = Math.floor(c.hour / 3);
    const k = `${c.day}:${b}`;
    grid.set(k, (grid.get(k) ?? 0) + c.count);
  }
  const max = Math.max(1, ...grid.values());
  let peak: { day: number; block: number; count: number } | null = null;
  for (const [k, count] of grid) {
    const [day, block] = k.split(':').map(Number);
    if (!peak || count > peak.count) peak = { day, block, count };
  }
  return (
    <div className="cp-heat">
      {peak && peak.count > 0 && (
        <div className="cp-heat-peak mono">Most active: <strong>{DOW[peak.day]} {blockRange(peak.block)}</strong> IST</div>
      )}
      <div className="cp-heat-hdr">
        <span />
        {BLOCK_LABELS.map((lbl, b) => <span key={b} className="mono">{lbl}</span>)}
      </div>
      {DOW.map((label, day) => (
        <div key={label} className="cp-heat-row">
          <span className="mono cp-heat-day">{label}</span>
          {BLOCK_LABELS.map((_, block) => {
            const n = grid.get(`${day}:${block}`) ?? 0;
            const isPeak = peak && peak.count > 0 && peak.day === day && peak.block === block;
            return (
              <span
                key={block}
                className={`cp-heat-cell${isPeak ? ' peak' : ''}`}
                title={`${label} ${blockRange(block)} IST — ${n} post${n === 1 ? '' : 's'}`}
                style={{ opacity: n ? 0.25 + 0.75 * (n / max) : 0.06 }}
              />
            );
          })}
        </div>
      ))}
      <div className="cp-heat-foot mono">
        <span>all sampled posts by weekday × time · IST</span>
        <span className="cp-heat-legend">
          less
          {[0.15, 0.45, 0.75, 1].map((o) => <span key={o} className="cp-heat-cell" style={{ opacity: o }} />)}
          more
        </span>
      </div>
    </div>
  );
};

const StrategyBlock: React.FC<{ s: NonNullable<Strategy> }> = ({ s }) => (
  <div className="cp-strategy">
    <div className="cp-plan">
      <div className="mono cp-stat-label">Recommended cadence</div>
      <div className="cp-plan-line"><strong>{s.plan.frequency}</strong> · {s.plan.bestDays.join(', ')} · {s.plan.bestTimes.join(', ')}</div>
      {s.plan.summary && <p className="cp-plan-sum">{s.plan.summary}</p>}
    </div>
    <div className="cp-dodont">
      <div className="cp-do">
        <div className="mono cp-stat-label">Do</div>
        <ul>{s.doList.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </div>
      <div className="cp-dont">
        <div className="mono cp-stat-label">Don&apos;t</div>
        <ul>{s.dontList.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </div>
    </div>
    <div className="cp-audience">
      <div className="cp-aud-tag mono">estimated from content signals · not measured</div>
      <p>{s.audience.estimate}</p>
      <span className="mono cp-aud-basis">basis: {s.audience.basis}</span>
    </div>
  </div>
);

const CompetitorsDashboard: React.FC = () => {
  const { data: rows, mutate } = useApi<Competitor[]>('/api/competitors');
  const { data: landscape, mutate: mutateLandscape } = useApi<Landscape>('/api/competitors/landscape');
  const [showAdd, setShowAdd] = useState(false);
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [insightsFor, setInsightsFor] = useState<string | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const add = async () => {
    if (!handle.trim()) return;
    setErr(null);
    try {
      await apiPost('/api/competitors', { handle: handle.trim(), displayName: name.trim() || undefined });
      setHandle(''); setName(''); setShowAdd(false);
      await mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add');
    }
  };

  const refreshLive = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await apiPost<{ scraped: number; failed: string[]; newPosts: number; source: string; error?: string }>('/api/competitors/refresh', {});
      setRefreshMsg(
        res.source === 'none'
          ? 'APIFY_TOKEN not set — add it to pull live data'
          : res.error
            ? `Apify error: ${res.error}${res.scraped ? ` (scraped ${res.scraped} first)` : ''}`
            : `Scraped ${res.scraped} · ${res.newPosts} new posts${res.failed.length ? ` · failed: ${res.failed.join(', ')}` : ''}`,
      );
      await Promise.all([mutate(), mutateLandscape()]);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const discover = async () => {
    setDiscovering(true);
    setRefreshMsg(null);
    try {
      const res = await apiPost<{ added: string[]; candidates: Array<{ handle: string }>; reason?: string; error?: string; scraped?: { newPosts: number } }>('/api/competitors/discover', {});
      setRefreshMsg(
        res.error ? `Apify error: ${res.error}`
          : res.reason === 'max_active' ? 'Already at 10 active competitors'
          : res.added.length ? `Discovered ${res.added.length}: ${res.added.map((h) => '@' + h).join(', ')}`
          : res.candidates.length ? `Found ${res.candidates.length} candidates but none had scrapeable niche data`
          : 'No niche competitors found yet — refresh Trends first',
      );
      await Promise.all([mutate(), mutateLandscape()]);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  };

  const remove = async (id: string) => {
    await apiDelete(`/api/competitors/${id}`);
    if (insightsFor === id) { setInsightsFor(null); setInsights(null); }
    await mutate();
  };

  const openInsights = async (id: string) => {
    if (insightsFor === id) { setInsightsFor(null); setInsights(null); return; }
    setInsightsFor(id);
    setInsights(null);
    setLoadingInsights(true);
    try {
      setInsights(await apiGet<Insights>(`/api/competitors/${id}/insights`));
    } finally {
      setLoadingInsights(false);
    }
  };

  const deepAnalyze = async (id: string) => {
    setAnalyzing(true);
    try {
      setInsights(await apiGet<Insights>(`/api/competitors/${id}/insights?analyze=1`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const active = (rows ?? []).filter((r) => r.isActive).length;
  const agg = landscape?.aggregate;

  return (
    <div className="cp-wrap">
      <div className="cp-toolbar">
        <span className="chip ghost mono">{active}/10 active</span>
        {landscape?.niche && <span className="chip ghost">{landscape.niche}</span>}
        <div style={{ flex: 1 }} />
        {refreshMsg && <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>{refreshMsg}</span>}
        <button className="btn sm" onClick={() => void discover()} disabled={discovering} title="Find niche competitors in India automatically from tracked-hashtag data">
          <Icon name="sparkle" size={12} /> {discovering ? 'Discovering…' : 'Auto-discover'}
        </button>
        <button className="btn sm" onClick={() => void refreshLive()} disabled={refreshing} title="Scrape live data for all tracked competitors">
          <Icon name="refresh" size={12} /> {refreshing ? 'Refreshing…' : 'Refresh live data'}
        </button>
        <button className="btn primary sm" onClick={() => setShowAdd(!showAdd)}>
          <Icon name="plus" size={12} /> Track competitor
        </button>
      </div>

      {showAdd && (
        <div className="card cp-add">
          <input className="cv-input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@handle" />
          <input className="cv-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name (optional)" />
          <button className="btn primary sm" onClick={() => void add()}>Add</button>
          {err && <span style={{ color: 'var(--bad)', fontSize: 12 }}>{err}</span>}
        </div>
      )}

      {agg && (
        <div className="card cp-landscape">
          <div className="card-head">
            <h3><Icon name="chart" size={14} /> Competitive landscape</h3>
            <span className="meta mono">{agg.count} tracked</span>
          </div>
          <div className="card-body">
            <div className="cp-land-stats">
              <div><div className="cp-stat-num mono">{agg.avgPostsPerWeek}/wk</div><div className="mono cp-stat-label">Avg posting rate</div></div>
              <div><div className="cp-stat-num mono">{agg.avgStoriesPerDay}/day</div><div className="mono cp-stat-label">Avg stories/day</div></div>
              <div>
                <div className="cp-stat-num mono">{agg.busiestHoursIST.map((h) => hourLabel(h.hour)).join(' · ') || '—'}</div>
                <div className="mono cp-stat-label">Crowded hours (IST)</div>
              </div>
              <div>
                <div className="cp-stat-num mono cp-white">{agg.whiteSpaceHoursIST.map((h) => hourLabel(h.hour)).join(' · ') || '—'}</div>
                <div className="mono cp-stat-label">White space — post here</div>
              </div>
            </div>
            {landscape?.strategy
              ? <StrategyBlock s={landscape.strategy} />
              : <div className="cp-strat-hint mono">Deterministic rollup shown. Set GROQ_API_KEY for an AI posting plan &amp; do/don&apos;t.</div>}
          </div>
        </div>
      )}

      <div className="cp-grid">
        {(rows ?? []).map((c) => (
          <div key={c.id} className={`card cp-card ${insightsFor === c.id ? 'open' : ''}`}>
            <div className="cp-card-head">
              <Pglyph p={PLATFORM_TO_SHORT[c.platform as Platform] ?? c.platform} size="lg" />
              <div className="cp-card-head-text">
                <strong>{c.displayName ?? c.handle}</strong>
                <div className="mono cp-handle">@{c.handle}</div>
              </div>
              <button className="btn ghost sm" title="Stop tracking" onClick={() => void remove(c.id)}>
                <Icon name="trash" size={11} />
              </button>
            </div>
            <div className="cp-stats">
              <div>
                <div className="mono cp-stat-num">{c.latestFollowers.toLocaleString('en-US')}</div>
                <div className="mono cp-stat-label">Followers</div>
              </div>
              <div>
                <div className="mono cp-stat-num">{(c.latestEngagementRate ?? 0).toFixed(2)}%</div>
                <div className="mono cp-stat-label">Engagement</div>
              </div>
              <Sparkline values={c.metrics.map((m) => m.followers ?? 0)} />
            </div>
            <button className="btn sm" onClick={() => void openInsights(c.id)}>
              <Icon name="chart" size={11} /> {insightsFor === c.id ? 'Hide insights' : 'Insights'}
            </button>
          </div>
        ))}
        {(rows ?? []).length === 0 && (
          <div className="apr-empty card" style={{ gridColumn: '1 / -1' }}>
            No competitors tracked yet. Seed data or add one above.
          </div>
        )}
      </div>

      {insightsFor && (
        <div className="card cp-insights">
          {loadingInsights && <div className="apr-empty">Analyzing…</div>}
          {insights && (
            <>
              <div className="card-head">
                <h3>@{insights.competitor.handle} — insights</h3>
                <span className="meta mono">{insights.sampleSize} posts sampled</span>
              </div>
              <div className="card-body cp-insight-grid">
                <div className="cp-insight">
                  <div className="mono cp-stat-label">Posting frequency</div>
                  <div className="cp-stat-num mono">{insights.postsPerWeek}/wk</div>
                </div>
                <div className="cp-insight">
                  <div className="mono cp-stat-label">Stories / day</div>
                  {insights.storiesTracked
                    ? <div className="cp-stat-num mono">{insights.storiesPerDay}<span className="cp-sub"> · {insights.storiesToday} today</span></div>
                    : <div className="cp-stat-num mono" title="Instagram Stories need an authenticated story scraper — not available via public scraping"><span className="cp-sub">not tracked</span></div>}
                </div>
                <div className="cp-insight">
                  <div className="mono cp-stat-label" title="This is engagement rate CHANGE over the window, not the rate itself — see the card's Engagement stat for the current rate">Engagement rate change (30d)</div>
                  <div className={`cp-stat-num mono ${insights.engagementTrend >= 0 ? 'tr-delta up' : 'tr-delta down'}`}>
                    {insights.engagementTrend >= 0 ? '▲' : '▼'} {Math.abs(insights.engagementTrend)}%
                    <span className="cp-sub"> · currently {insights.latestEngagementRate.toFixed(2)}%</span>
                  </div>
                </div>
                <div className="cp-insight">
                  <div className="mono cp-stat-label">Follower growth (30d)</div>
                  <div className={`cp-stat-num mono ${insights.followerGrowth >= 0 ? 'tr-delta up' : 'tr-delta down'}`}>
                    {insights.followerGrowth >= 0 ? '▲' : '▼'} {Math.abs(insights.followerGrowth)}%
                  </div>
                </div>
                <div className="cp-insight cp-wide">
                  <div className="mono cp-stat-label">Upload heatmap</div>
                  <div className="cp-heat-layout">
                    <Heatmap cells={insights.heatmap} />
                    <div className="cp-heat-side">
                      <div>
                        <div className="mono cp-stat-label">Best times (IST)</div>
                        <div className="cp-heat-side-val">{insights.bestTimes.map((t) => t.hour).join(' · ') || '—'}</div>
                      </div>
                      <div>
                        <div className="mono cp-stat-label">Best days</div>
                        <div className="cp-heat-side-val">{insights.bestDaysLabeled.map((d) => d.day).join(' · ') || '—'}</div>
                      </div>
                      <div>
                        <div className="mono cp-stat-label">Format mix</div>
                        <div className="cp-fmt">
                          <span className="chip"><FmtIcon k="reel" /> {insights.formatMix.reel} Reels</span>
                          <span className="chip"><FmtIcon k="carousel" /> {insights.formatMix.carousel} Carousels</span>
                          <span className="chip"><FmtIcon k="image" /> {insights.formatMix.image} Images</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="cp-insight cp-wide">
                  <div className="mono cp-stat-label">Top themes</div>
                  <div className="sch-chip-row">
                    {insights.topThemes.map((t) => (
                      <span key={t.theme} className="chip">{t.theme} · {t.avgEngagement.toLocaleString('en-US')} avg</span>
                    ))}
                  </div>
                </div>
                <div className="cp-insight cp-wide">
                  <div className="mono cp-stat-label">Hashtag strategy</div>
                  <div className="sch-chip-row">
                    {insights.hashtagStrategy.map((h) => (
                      <span key={h.tag} className="chip ghost">{h.tag} ×{h.uses}</span>
                    ))}
                  </div>
                </div>
                {insights.topAudios.length > 0 && (
                  <div className="cp-insight cp-wide">
                    <div className="mono cp-stat-label">Audio they ride</div>
                    <div className="sch-chip-row">
                      {insights.topAudios.map((a) => <span key={a.title} className="chip">{a.title} ×{a.uses}</span>)}
                    </div>
                  </div>
                )}
              </div>
              <div className="cp-analyze">
                {insights.strategy
                  ? <StrategyBlock s={insights.strategy} />
                  : (
                    <button className="btn sm primary" onClick={() => void deepAnalyze(insights.competitor.id)} disabled={analyzing}>
                      <Icon name="sparkle" size={12} /> {analyzing ? 'Analyzing…' : 'AI strategy & audience (uses 1 analysis)'}
                    </button>
                  )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default CompetitorsDashboard;
