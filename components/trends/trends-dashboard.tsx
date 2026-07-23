'use client';

import React, { useState } from 'react';
import { Icon, Pglyph } from '../icons';
import { Sparkline } from '../spark';
import { useApi, apiPost } from '../../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { TrendData, WowComparison } from '../../lib/taccv/trend-analysis';
import type { GeneralAngle, BrandStrategy } from '../../lib/intel/strategist';

type TrendsPayload = Omit<TrendData, 'top_audio'> & {
  top_audio: Array<TrendData['top_audio'][number] & { topPostUrl: string | null }>;
  summary: string | null;
  wow: WowComparison | null;
  general: GeneralAngle[];
  strategy: BrandStrategy;
  settings: { hashtags: string[]; niche: string | null; selfHandle: string | null; companyDescription: string | null };
};

type Stage = 'emerging' | 'rising' | 'peaking' | 'declining';
type RadarItem = {
  entity: string; kind: 'hashtag' | 'audio'; stage: Stage;
  velocityPct: number; peakAt: string | null; hoursToPeak: number | null;
  confidence: number; series: number[]; fit: number;
  verdict: 'go' | 'watch' | 'skip' | null; tip: string | null;
};
type AudioItem = {
  title: string; stage: Stage; velocityPct: number; hoursToPeak: number | null;
  confidence: number; series: number[]; topPostUrl: string | null;
};
type RadarPayload = {
  generatedAt: string; horizonHours: number; niche: string | null;
  watchlist: RadarItem[]; radar: RadarItem[]; audios: AudioItem[];
};

type CrossPlatformItem = {
  entity: string; kind: 'hashtag' | 'audio'; stage: Stage; platform: 'tiktok' | 'youtube';
  velocityPct: number; hoursToPeak: number | null; confidence: number; series: number[];
  fitBase?: number; highAlert: boolean; verdict: 'go' | 'watch' | 'skip' | null; tip: string | null;
};
type CrossPlatformPayload = { opportunities: CrossPlatformItem[]; highAlertCount: number; highAlertHours: number };

const STAGE_LABEL: Record<Stage, string> = { emerging: 'Emerging', rising: 'Rising', peaking: 'Peaking', declining: 'Declining' };

const CopyableText: React.FC<{ text: string; className?: string; title?: string; children?: React.ReactNode }> = ({ text, className, title, children }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <span
      className={`${className || ''} tr-copyable ${copied ? 'copied' : ''}`}
      title={copied ? "Copied!" : (title || `Click to copy`)}
      onClick={handleCopy}
    >
      {copied ? <span style={{ color: 'var(--good)' }}><Icon name="check" size={12} /> Copied</span> : (children || text)}
    </span>
  );
};

// Wraps a hashtag in a real link to Instagram's explore page, with a small
// separate copy affordance — the "hashtag -> Instagram" redirect (V2_Plan.md §6).
const TagLink: React.FC<{ tag: string; className?: string }> = ({ tag, className }) => {
  const [copied, setCopied] = useState(false);
  const clean = tag.replace(/^#/, '');
  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(`#${clean}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <a
      href={`https://www.instagram.com/explore/tags/${encodeURIComponent(clean)}/`}
      target="_blank"
      rel="noreferrer"
      className={`${className || ''} tr-taglink`}
      title={`Open #${clean} on Instagram`}
    >
      <span className="tr-taglink-text">#{clean}</span>
      <span className="tr-tag-copy" onClick={handleCopy}>{copied ? 'copied' : 'copy'}</span>
    </a>
  );
};

function countdown(hours: number | null): string {
  if (hours === null) return 'peak unknown';
  if (hours < -12) return 'peaked';
  if (hours <= 6) return 'peaking now';
  if (hours < 48) return `peaks in ${hours}h`;
  return `peaks in ${Math.round(hours / 24)}d`;
}
function verdictClass(v: RadarItem['verdict']): string {
  return v === 'go' ? 'go' : v === 'skip' ? 'skip' : 'watch';
}

const TrendsDashboard: React.FC = () => {
  const { data, error, mutate, isLoading } = useApi<TrendsPayload>('/api/trend-intel');
  const { data: radar } = useApi<RadarPayload>('/api/trend-intel/radar');
  const { data: cross } = useApi<CrossPlatformPayload>('/api/trend-intel/cross-platform');
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [hashtagsInput, setHashtagsInput] = useState('');
  const [selfHandleInput, setSelfHandleInput] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [descInput, setDescInput] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setMsg(null);
    try {
      const res = await apiPost<{ skipped: boolean; reason?: string; error?: string; postCount?: number }>('/api/trend-intel/refresh?force=1', {});
      setMsg(
        !res.skipped ? `New snapshot: ${res.postCount} posts`
          : res.reason === 'apify_error' ? `Apify limit reached — ${res.error}`
          : `Refresh skipped (${res.reason})`,
      );
      await mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const saveSettings = async () => {
    const hashtags = hashtagsInput.split(/[,\s]+/).map((h) => h.replace(/^#/, '').trim()).filter(Boolean);
    if (!hashtags.length) return;
    await apiPost('/api/trend-intel/settings', { hashtags, selfHandle: selfHandleInput.trim().replace(/^@/, '') });
    setShowSettings(false);
    await mutate();
  };

  const analyzeCompany = async (description: string) => {
    const trimmed = description.trim();
    if (!trimmed) return;
    setAnalyzing(true);
    setAnalyzeMsg(null);
    try {
      const res = await apiPost<{ niche: string; hashtags: string[]; competitorsAdded: string[]; warning?: string }>(
        '/api/company/analyze',
        { description: trimmed },
      );
      setAnalyzeMsg(
        res.warning ? res.warning
          : `Derived niche "${res.niche}" · ${res.hashtags.length} hashtags` +
            (res.competitorsAdded.length ? ` · ${res.competitorsAdded.length} competitor${res.competitorsAdded.length === 1 ? '' : 's'} found` : ''),
      );
      await mutate();
    } catch (e) {
      setAnalyzeMsg(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  if (isLoading) return <div className="tr-empty">Loading trends…</div>;
  if (error || !data) {
    return (
      <div className="tr-empty card">
        <Icon name="trend" size={22} />
        <strong>No trend data yet</strong>
        <span>Run <code>npm run seed</code> or hit Refresh to pull a snapshot.</span>
        <button className="btn primary" onClick={refresh} disabled={refreshing}>
          <Icon name="refresh" size={12} /> {refreshing ? 'Refreshing…' : 'Refresh now'}
        </button>
        {msg && <span style={{ color: 'var(--warn)', fontSize: 12 }}>{msg}</span>}
      </div>
    );
  }

  const kpis = [
    { label: 'Posts', value: data.kpis.posts },
    { label: 'Creators', value: data.kpis.creators },
    { label: 'Total Engagement', value: data.kpis.total_eng.toLocaleString('en-US') },
    { label: 'Avg Engagement', value: data.kpis.avg_eng },
    { label: 'Reels %', value: `${data.kpis.reels_pct}%` },
    { label: 'Hidden Likes %', value: `${data.kpis.hidden_pct}%` },
  ];

  const topReels = data.top_posts.filter((p) => p.is_reel);
  const topOtherPosts = data.top_posts.filter((p) => !p.is_reel);
  const audioTopPost = new Map(data.top_audio.map((a) => [a.track, a.topPostUrl]));
  const describeValue = descInput ?? (data.settings.companyDescription ?? '');

  return (
    <div className="tr-wrap">
      <div className="tr-toolbar">
        <span className="chip ghost mono">{data.source}</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => { setHashtagsInput(data.settings.hashtags.join(', ')); setSelfHandleInput(data.settings.selfHandle ?? ''); setShowSettings(!showSettings); }}>
          <Icon name="settings" size={12} /> Advanced
        </button>
        <button className="btn sm primary" onClick={refresh} disabled={refreshing}>
          <Icon name="refresh" size={12} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {msg && <div className="tr-msg mono">{msg}</div>}

      <div className="card tr-describe">
        <div className="card-head"><h3>Describe your company</h3><span className="meta mono">auto-derives niche + hashtags</span></div>
        <div className="card-body">
          <textarea
            className="tr-input"
            style={{ minHeight: 84, resize: 'vertical', fontFamily: 'inherit', width: '100%' }}
            value={describeValue}
            onChange={(e) => setDescInput(e.target.value)}
            placeholder="Describe your company — we'll derive tracked hashtags, niche, and the analysis below from it."
            maxLength={2000}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {data.settings.hashtags.map((h) => <span key={h} className="chip ghost mono">#{h}</span>)}
            <div style={{ flex: 1 }} />
            <button className="btn primary sm" onClick={() => void analyzeCompany(describeValue)} disabled={analyzing || !describeValue.trim()}>
              <Icon name="sparkle" size={12} /> {analyzing ? 'Analyzing…' : 'Refresh / Analyze'}
            </button>
          </div>
          {analyzeMsg && <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{analyzeMsg}</span>}
        </div>
      </div>

      <div className="tr-scope-note mono">
        <Icon name="target" size={12} />
        <div>
          Everything below is scoped to <strong>your tracked hashtags</strong>
          {data.settings.hashtags.length > 0 && <> ({data.settings.hashtags.map((h) => `#${h}`).join(', ')})</>} — your
          niche&apos;s activity, not Instagram-wide. The <strong>Categories</strong> panel is the one exception: it also
          scrapes the general-trend catalog (entertainment/news/sports/viral/dance) so you can see how your niche compares
          to Instagram-wide activity — look for the <strong>General Instagram</strong> heading there, and the
          <strong> Analysis · General</strong> section below for the full breakdown.
        </div>
      </div>

      {showSettings && (
        <div className="card tr-settings">
          <div className="card-head"><h3>Advanced: tracked hashtags &amp; your handle</h3></div>
          <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="tr-input"
              style={{ flex: 2, minWidth: 220 }}
              value={hashtagsInput}
              onChange={(e) => setHashtagsInput(e.target.value)}
              placeholder="hometheatre, dolbyatmos, homecinema"
            />
            <input
              className="tr-input"
              style={{ flex: 1, minWidth: 140 }}
              value={selfHandleInput}
              onChange={(e) => setSelfHandleInput(e.target.value)}
              placeholder="your @handle (excluded from discovery)"
            />
            <button className="btn primary sm" onClick={() => void saveSettings()}>Save</button>
          </div>
        </div>
      )}

      <h2 className="tr-section-head">Analysis · Niche</h2>

      {radar && <ViralRadar radar={radar} />}
      {cross && cross.opportunities.length > 0 && <CrossPlatformRadar data={cross} />}

      <div className="tr-kpi-row">
        {kpis.map((k) => (
          <div key={k.label} className="tr-kpi card">
            <div className="tr-kpi-value mono">{k.value}</div>
            <div className="tr-kpi-label mono">{k.label}</div>
          </div>
        ))}
      </div>

      {data.summary && (
        <div className="card tr-summary">
          <div className="card-head"><h3>AI Summary</h3><span className="meta mono">Groq</span></div>
          <div className="card-body"><p>{data.summary}</p></div>
        </div>
      )}

      {data.wow && (
        <div className="card">
          <div className="card-head">
            <h3>Momentum · {data.wow.comparison_type === 'week_over_week' ? 'week over week' : 'vs previous snapshot'}</h3>
            <span className="meta mono">{Math.round(data.wow.time_delta_hours / 24)}d apart</span>
          </div>
          <div className="card-body">
            <div className="tr-wow-explain tr-scope-note mono" style={{ marginBottom: '16px', maxWidth: 'none' }}>
              <Icon name="trend" size={12} />
              <div>
                For each hashtag you track, this compares the average engagement of its scraped posts <strong>then vs now</strong>.
                Niche hashtags post infrequently, so &ldquo;Flat&rdquo; here is normal and doesn&apos;t mean broken data — for
                real-time momentum, use the <strong>Going viral</strong> radar above instead, which is built for that.
              </div>
            </div>
            <div className="tr-wow">
              <div className="tr-wow-row tr-wow-head mono">
                <span>Hashtag</span>
                <span>Then → Now (avg engagement)</span>
                <span>Change</span>
              </div>
              {data.wow.categories.map((c) => {
                const flat = Math.abs(c.delta_pct) < 1;
                return (
                  <div key={c.category} className="tr-wow-row">
                    <CopyableText text={`#${c.category}`} className="tr-tag">#{c.category}</CopyableText>
                    <span className="mono">{c.prev_avg} → {c.current_avg}</span>
                    <span className={`mono tr-delta ${flat ? 'flat' : c.delta_pct >= 0 ? 'up' : 'down'}`}>
                      {flat ? '· Flat' : `${c.delta_pct >= 0 ? '▲' : '▼'} ${Math.abs(c.delta_pct)}%`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="tr-panels">
        <RankPanel
          title="Categories · your niche"
          hint="tracked hashtag"
          isTag
          rows={data.categories.filter((c) => c.scope === 'niche').map((c) => ({ name: c.name, n: c.n, avg: c.avg }))}
        />
        {data.categories.some((c) => c.scope === 'general') && (
          <RankPanel
            title="Categories · General Instagram"
            hint="general-trend catalog tag, for comparison only"
            isTag
            rows={data.categories.filter((c) => c.scope === 'general').map((c) => ({ name: c.name, n: c.n, avg: c.avg }))}
          />
        )}
        <RankPanel title="Formats" hint="your niche only" rows={data.formats} />
        <RankPanel
          title="Hashtags"
          hint="co-occurring in your niche"
          isTag
          rows={data.hashtags.map((h) => ({ name: splitTags([h.tag])[0] ?? h.tag, n: h.n, avg: h.avg }))}
        />
        {data.top_audio.length > 0 && (
          <RankPanel
            title="Trending Audio"
            hint="your niche only"
            rows={data.top_audio.map((a) => ({ name: a.track, n: a.n, avg: a.score }))}
            avgLabel="score"
            linkFor={(name) => audioTopPost.get(name) ?? null}
          />
        )}
      </div>

      <div className="card">
        <div className="card-head"><h3>Recommendation</h3></div>
        <div className="card-body tr-rec">
          <p>
            Post a <strong>{data.rec.format}</strong> in the <strong>{data.rec.category}</strong> niche
            {data.rec.format_lift > 1 && <> — top format outperforms the weakest by <strong>{data.rec.format_lift}×</strong></>}.
          </p>
          <RecTags tags={data.rec.tags} />
          {data.rec.hooks.length > 0 && (
            <div className="tr-hooks">
              <div className="tr-hooks-label mono">Top-scoring hooks in this niche</div>
              {data.rec.hooks.slice(0, 6).map((h, i) => (
                <div key={`${h.hook}-${i}`} className="tr-hook">
                  <span className="mono tr-hook-score">{h.score.toLocaleString('en-US')}</span>
                  <span className="tr-hook-text" title={h.hook}>{h.hook}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="tr-panels">
        <PostListCard title="Top reels" posts={topReels} />
        <PostListCard title="Top posts" posts={topOtherPosts} />
      </div>

      {data.general.length > 0 && (
        <>
          <h2 className="tr-section-head">Analysis · General</h2>
          <div className="tr-general-grid">
            {data.general.map((b) => (
              <div key={b.bucket} className="card tr-general-card">
                <div className="card-head">
                  <h3>{b.label}</h3>
                  <span className="meta mono">{b.topReels.length + b.topPosts.length} posts</span>
                </div>
                <div className="card-body">
                  {b.angle && <p className="tr-general-angle">{b.angle}</p>}
                  {b.idea && <div className="tr-general-idea">💡 <strong>Idea:</strong> {b.idea}</div>}
                  {b.topAudio.length > 0 && (
                    <div className="tr-general-audio">
                      {b.topAudio.slice(0, 2).map((a) => (
                        <a key={a.track} href={a.topPostUrl} target="_blank" rel="noreferrer" className="tr-audio-chip">
                          <Icon name="waveform" size={11} /> {a.track}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="tr-general-posts">
                    {[...b.topReels.slice(0, 3), ...b.topPosts.slice(0, 2)].map((p) => (
                      <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="tr-post">
                        <div className="tr-post-head">
                          <span className="mono tr-post-score">{p.score.toLocaleString('en-US')}</span>
                          <span className="chip ghost">{p.type}{p.isReel ? ' · Reel' : ''}</span>
                        </div>
                        <div className="tr-post-owner mono">@{p.owner || 'unknown'}</div>
                        <p>{(p.caption || '').slice(0, 100) || '(no caption)'}</p>
                      </a>
                    ))}
                    {b.topReels.length + b.topPosts.length === 0 && <span className="tr-radar-empty">No posts yet.</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="tr-section-head">Strategy</h2>
      <div className="card tr-strategy">
        <div className="card-head"><h3>Brand strategy</h3><span className="meta mono">Groq</span></div>
        <div className="card-body">
          {data.strategy.summary && <p>{data.strategy.summary}</p>}
          <div className="tr-strategy-grid">
            <div>
              <div className="tr-hooks-label mono">Hooks to follow</div>
              {data.strategy.hooksToFollow.length > 0 ? (
                <div className="tr-hooks" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
                  {data.strategy.hooksToFollow.map((h, i) => (
                    <div key={i} className="tr-hook"><span className="tr-hook-text">{h}</span></div>
                  ))}
                </div>
              ) : <span className="tr-radar-empty">No hooks yet.</span>}
            </div>
            <div>
              <div className="tr-hooks-label mono">Weekly plan</div>
              <p>{data.strategy.weeklyPlan}</p>
            </div>
            <div>
              <div className="tr-hooks-label mono">Trends to ride</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {data.strategy.trendsToRide.length > 0
                  ? data.strategy.trendsToRide.map((t) => <span key={t} className="chip">{t}</span>)
                  : <span className="tr-radar-empty">None yet.</span>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const PostListCard: React.FC<{ title: string; posts: TrendData['top_posts'] }> = ({ title, posts }) => (
  <div className="card">
    <div className="card-head"><h3>{title}</h3><span className="meta mono">{posts.length}</span></div>
    <div className="card-body tr-posts">
      {posts.map((p) => (
        <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="tr-post">
          <div className="tr-post-head">
            <span className="mono tr-post-score">{p.score.toLocaleString('en-US')}</span>
            <span className="chip ghost">{p.type}{p.is_reel ? ' · Reel' : ''}</span>
          </div>
          <div className="tr-post-owner mono">@{p.owner || 'unknown'}</div>
          <p>{p.caption.slice(0, 120) || '(no caption)'}</p>
        </a>
      ))}
      {posts.length === 0 && <span style={{ color: 'var(--ink-4)', fontSize: 12 }}>No data.</span>}
    </div>
  </div>
);

const ViralRadar: React.FC<{ radar: RadarPayload }> = ({ radar }) => {
  const watch = [...radar.watchlist].sort((a, b) => b.fit - a.fit || (a.hoursToPeak ?? 0) - (b.hoursToPeak ?? 0));
  return (
    <>
      <div className="card tr-radar">
        <div className="card-head">
          <h3><Icon name="trend" size={14} /> Going viral · next {radar.horizonHours}h</h3>
          <span className="meta mono">prep during rising, post at peak{radar.niche ? ` · ${radar.niche}` : ''}</span>
        </div>
        <div className="card-body">
          <div className="tr-legend mono">
            <span><strong>fit</strong> = how well it matches your niche (0–100)</span>
            <span><strong>%/d</strong> = engagement growth per day (▲ rising, ▼ cooling)</span>
            <span><strong>conf</strong> = forecast confidence</span>
          </div>
          {watch.length === 0 ? (
            <div className="tr-radar-empty">No trends are projected to peak in the next {radar.horizonHours}h. Check the lifecycle radar below for what&apos;s still climbing.</div>
          ) : (
            <div className="tr-viral-grid">
              {watch.map((it) => (
                <div key={it.entity} className={`tr-viral ${it.stage}`}>
                  <div className="tr-viral-top">
                    <TagLink tag={it.entity} className="tr-tag" />
                    <span className={`tr-fit ${verdictClass(it.verdict)}`} title="niche-fit score">fit {it.fit}</span>
                  </div>
                  <div className="tr-viral-when mono">{countdown(it.hoursToPeak)}</div>
                  <div className="tr-viral-meta">
                    <span className={`tr-stage ${it.stage}`}>{STAGE_LABEL[it.stage]}</span>
                    <span className="mono tr-vel">{it.velocityPct >= 0 ? '▲' : '▼'} {Math.abs(it.velocityPct)}%/d</span>
                    <span className="mono tr-conf">{it.confidence}% conf</span>
                  </div>
                  <Sparkline values={it.series} width={150} height={30} />
                  {it.tip && (
                    <div className="tr-viral-tip">
                      {it.verdict === 'skip' ? <>⚠ {it.tip}</> : <><strong>💡 Content idea:</strong> {it.tip}</>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="tr-panels">
        <div className="card">
          <div className="card-head"><h3>Lifecycle radar</h3><span className="meta mono">fit-sorted</span></div>
          <div className="card-body tr-life">
            {radar.radar.map((it) => (
              <div key={it.entity} className="tr-life-row">
                <span className={`tr-stage ${it.stage}`}>{STAGE_LABEL[it.stage]}</span>
                <TagLink tag={it.entity} className="tr-life-name" />
                <Sparkline values={it.series} width={90} height={22} />
                <span className="mono tr-vel">{it.velocityPct >= 0 ? '▲' : '▼'}{Math.abs(it.velocityPct)}%</span>
                <span className={`tr-fit-sm ${it.fit >= 60 ? 'go' : it.fit >= 35 ? 'watch' : 'skip'}`}>fit {it.fit}</span>
              </div>
            ))}
            {radar.radar.length === 0 && <span className="tr-radar-empty">No tracked hashtags with enough history yet.</span>}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Trending audio</h3><span className="meta mono">rising first</span></div>
          <div className="card-body tr-life">
            {radar.audios.map((a) => (
              <div key={a.title} className="tr-life-row">
                <span className={`tr-stage ${a.stage}`}>{STAGE_LABEL[a.stage]}</span>
                <CopyableText text={a.title} className="tr-life-name" title={a.title}>{a.title}</CopyableText>
                {a.topPostUrl && (
                  <a href={a.topPostUrl} target="_blank" rel="noreferrer" className="tr-audio-play" title="Open top reel using this audio">
                    <Icon name="play" size={10} />
                  </a>
                )}
                <Sparkline values={a.series} width={90} height={22} />
                <span className="mono tr-when-sm">{countdown(a.hoursToPeak)}</span>
              </div>
            ))}
            {radar.audios.length === 0 && <span className="tr-radar-empty">No audio trends detected.</span>}
          </div>
        </div>
      </div>
    </>
  );
};

const CrossPlatformRadar: React.FC<{ data: CrossPlatformPayload }> = ({ data }) => {
  const items = [...data.opportunities].sort((a, b) => Number(b.highAlert) - Number(a.highAlert) || (b.fitBase ?? 0) - (a.fitBase ?? 0));
  return (
    <div className="card tr-radar tr-xplat">
      <div className="card-head">
        <h3><Icon name="alert" size={14} /> Cross-platform radar{data.highAlertCount > 0 ? ` · ${data.highAlertCount} act now` : ''}</h3>
        <span className="meta mono">rising on TikTok/YouTube, not yet on your Instagram</span>
      </div>
      <div className="card-body">
        <div className="tr-wow-explain tr-scope-note mono" style={{ marginBottom: '16px', maxWidth: 'none' }}>
          <Icon name="alert" size={12} />
          <div>
            These are on-niche hashtags or sounds gaining traction on TikTok or YouTube Shorts that haven&apos;t caught on in
            your Instagram niche yet — the lead-time window to prep content and post before your Instagram audience (and
            competitors) catch up. <strong>Act now</strong> means the source platform&apos;s own peak is within {data.highAlertHours}h.
          </div>
        </div>
        <div className="tr-viral-grid">
          {items.map((it) => (
            <div key={`${it.platform}-${it.entity}`} className={`tr-viral ${it.stage} ${it.highAlert ? 'high-alert' : ''}`}>
              <div className="tr-viral-top">
                <CopyableText text={it.kind === 'hashtag' ? `#${it.entity}` : it.entity} className="tr-tag">
                  <Pglyph p={PLATFORM_TO_SHORT[it.platform]} size="lg" /> {it.kind === 'hashtag' ? `#${it.entity}` : it.entity}
                </CopyableText>
                {it.highAlert && <span className="tr-highalert mono">⚡ act now</span>}
              </div>
              <div className="tr-viral-when mono">{countdown(it.hoursToPeak)} on {it.platform}</div>
              <div className="tr-viral-meta">
                <span className={`tr-stage ${it.stage}`}>{STAGE_LABEL[it.stage]}</span>
                <span className="mono tr-vel">{it.velocityPct >= 0 ? '▲' : '▼'} {Math.abs(it.velocityPct)}%/d</span>
                <span className="mono tr-conf" title="niche-fit score">fit {it.fitBase ?? 0}</span>
              </div>
              <Sparkline values={it.series} width={150} height={30} />
              {it.tip && <div className="tr-viral-tip">{it.verdict === 'skip' ? '⚠ ' : '→ '}{it.tip}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

function splitTags(tags: string[]): string[] {
  return [...new Set(tags.flatMap((t) => t.split('|').map((p) => p.trim()).filter(Boolean)))];
}

const RecTags: React.FC<{ tags: string[] }> = ({ tags }) => {
  const flat = splitTags(tags);
  const shown = flat.slice(0, 10);
  const rest = flat.length - shown.length;
  return (
    <div className="tr-rec-tags">
      {shown.map((t) => <TagLink key={t} tag={t} className="chip" />)}
      {rest > 0 && <span className="chip ghost">+{rest} more</span>}
    </div>
  );
};

const RankPanel: React.FC<{
  title: string;
  rows: Array<{ name: string; n: number; avg: number }>;
  avgLabel?: string;
  hint?: string;
  isTag?: boolean;
  linkFor?: (name: string) => string | null;
}> = ({ title, rows, avgLabel = 'avg', hint, isTag, linkFor }) => {
  const max = Math.max(...rows.map((r) => r.avg), 1);
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
        <span className="meta mono" title={`Bar length and the first number = ${avgLabel} engagement per post. The second number = how many posts it's based on.${hint ? ` Each row is one ${hint}.` : ''}`}>
          {avgLabel} eng. · sample size
        </span>
      </div>
      <div className="card-body tr-rank">
        {rows.slice(0, 8).map((r) => {
          const link = linkFor?.(r.name) ?? null;
          return (
            <div key={r.name} className="tr-rank-row">
              {isTag ? (
                <TagLink tag={r.name} className="tr-rank-name" />
              ) : (
                <span className="tr-rank-name-wrap">
                  <CopyableText text={r.name} className="tr-rank-name" title={r.name}>{r.name}</CopyableText>
                  {link && (
                    <a href={link} target="_blank" rel="noreferrer" className="tr-audio-play" title="Open top post using this audio">
                      <Icon name="play" size={10} />
                    </a>
                  )}
                </span>
              )}
              <div className="tr-rank-bar"><div style={{ width: `${(r.avg / max) * 100}%` }} /></div>
              <span className="mono tr-rank-avg" title={`${avgLabel} engagement per post`}>{r.avg.toLocaleString('en-US')}</span>
              <span className="mono tr-rank-n" title="posts sampled">{r.n} post{r.n === 1 ? '' : 's'}</span>
            </div>
          );
        })}
        {rows.length === 0 && <span style={{ color: 'var(--ink-4)', fontSize: 12 }}>No data.</span>}
      </div>
    </div>
  );
};

export default TrendsDashboard;
