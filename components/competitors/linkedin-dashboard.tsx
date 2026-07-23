'use client';

import React, { useState } from 'react';
import { Icon, Pglyph } from '../icons';
import { Sparkline } from '../spark';
import { useApi, apiPost, apiDelete } from '../../lib/ui/fetcher';
import { growthPct, type LiCompany, type LiLandscape } from '../../lib/intel/linkedin-intel';

type Payload = { companies: LiCompany[]; landscape: LiLandscape | null };

const Delta: React.FC<{ pct: number }> = ({ pct }) => (
  <span className={`mono ${pct >= 0 ? 'tr-delta up' : 'tr-delta down'}`}>
    {pct >= 0 ? '▲' : '▼'} {Math.abs(pct)}%
  </span>
);

const LinkedInDashboard: React.FC = () => {
  const { data, mutate, isLoading } = useApi<Payload>('/api/linkedin');
  const [showAdd, setShowAdd] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showDiscover, setShowDiscover] = useState(false);
  const [description, setDescription] = useState('');
  const [discovering, setDiscovering] = useState(false);

  const add = async () => {
    if (!url.trim()) return;
    setErr(null);
    try {
      await apiPost('/api/linkedin', { url: url.trim(), name: name.trim() || undefined });
      setUrl(''); setName(''); setShowAdd(false);
      await mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add');
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setMsg(null);
    try {
      const res = await apiPost<{ scraped: number; failed: string[]; source: string; error?: string }>('/api/linkedin/refresh', {});
      setMsg(
        res.source === 'none' ? 'APIFY_TOKEN not set — add it to pull live data'
          : res.error ? `Apify error: ${res.error}${res.scraped ? ` (updated ${res.scraped} first)` : ''}`
          : `Updated ${res.scraped}${res.failed.length ? ` · failed: ${res.failed.join(', ')}` : ''}`,
      );
      await mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const discover = async () => {
    if (!description.trim()) return;
    setDiscovering(true);
    setMsg(null);
    try {
      const res = await apiPost<{ added: string[]; keyword: string; reason?: string; error?: string }>(
        '/api/linkedin/discover', { description: description.trim() },
      );
      setMsg(
        res.error ? `Apify error: ${res.error}`
          : res.reason === 'max_active' ? 'Already at 10 tracked companies'
          : res.added.length ? `Discovered ${res.added.length} (search: “${res.keyword}”): ${res.added.join(', ')}`
          : `No new companies found for “${res.keyword}”`,
      );
      if (res.added?.length) { setShowDiscover(false); setDescription(''); }
      await mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  };

  const remove = async (id: string) => {
    await apiDelete(`/api/linkedin/${id}`);
    await mutate();
  };

  if (isLoading) return <div className="apr-empty card">Loading LinkedIn companies…</div>;

  const companies = data?.companies ?? [];
  const ls = data?.landscape ?? null;
  const active = companies.length;

  return (
    <div className="cp-wrap">
      <div className="cp-toolbar">
        <span className="chip ghost mono">{active}/10 tracked</span>
        <Pglyph p="li" size="lg" />
        <div style={{ flex: 1 }} />
        {msg && <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>{msg}</span>}
        <button className="btn sm" onClick={() => setShowDiscover(!showDiscover)} title="Find LinkedIn competitors from your company description">
          <Icon name="sparkle" size={12} /> Auto-discover
        </button>
        <button className="btn sm" onClick={() => void refresh()} disabled={refreshing} title="Scrape live data for all tracked companies">
          <Icon name="refresh" size={12} /> {refreshing ? 'Refreshing…' : 'Refresh live data'}
        </button>
        <button className="btn primary sm" onClick={() => setShowAdd(!showAdd)}>
          <Icon name="plus" size={12} /> Track company
        </button>
      </div>

      {showDiscover && (
        <div className="card cp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <textarea
            className="cv-input"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe your company — e.g. 'Premium home theatre & Dolby Atmos home cinema installation for luxury villas'"
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn primary sm" onClick={() => void discover()} disabled={discovering}>
              <Icon name="sparkle" size={12} /> {discovering ? 'Searching LinkedIn…' : 'Find competitors'}
            </button>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>
              searches LinkedIn companies, adds + scrapes the top matches (uses 1 analysis)
            </span>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="card cp-add">
          <input className="cv-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="linkedin.com/company/xyz  ·  or just  xyz" />
          <input className="cv-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name (optional)" />
          <button className="btn primary sm" onClick={() => void add()}>Add</button>
          {err && <span style={{ color: 'var(--bad)', fontSize: 12 }}>{err}</span>}
        </div>
      )}

      <div className="tr-scope-note mono">
        <Icon name="target" size={12} />
        <div>
          LinkedIn company pages expose <strong>firmographics + follower/employee counts</strong>, not a public post feed —
          so this tracks growth and company profile, not per-post engagement. Growth builds up as daily snapshots
          accumulate (hit Refresh, or let the cron run).
        </div>
      </div>

      {ls && (
        <div className="card cp-landscape">
          <div className="card-head">
            <h3><Icon name="chart" size={14} /> LinkedIn landscape</h3>
            <span className="meta mono">{ls.count} tracked</span>
          </div>
          <div className="card-body">
            <div className="cp-land-stats">
              <div><div className="cp-stat-num mono">{ls.avgFollowers.toLocaleString('en-US')}</div><div className="mono cp-stat-label">Avg followers</div></div>
              <div><div className="cp-stat-num mono">{ls.avgEmployees.toLocaleString('en-US')}</div><div className="mono cp-stat-label">Avg employees</div></div>
              <div>
                <div className="cp-stat-num mono">{ls.topFollowerGain ? `${ls.topFollowerGain.name ?? ls.topFollowerGain.slug} ·` : '—'} {ls.topFollowerGain ? `${ls.topFollowerGain.pct}%` : ''}</div>
                <div className="mono cp-stat-label">Fastest follower growth</div>
              </div>
              <div>
                <div className="cp-stat-num mono">{ls.topHeadcountGain ? `${ls.topHeadcountGain.name ?? ls.topHeadcountGain.slug} ·` : '—'} {ls.topHeadcountGain ? `${ls.topHeadcountGain.pct}%` : ''}</div>
                <div className="mono cp-stat-label">Fastest hiring (headcount)</div>
              </div>
            </div>
            {ls.industries.length > 0 && (
              <div className="sch-chip-row" style={{ marginTop: 12 }}>
                {ls.industries.map((i) => <span key={i.industry} className="chip ghost">{i.industry} ×{i.count}</span>)}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="cp-grid">
        {companies.map((c) => {
          const fGrowth = growthPct(c.metrics.map((m) => m.followers));
          const eGrowth = growthPct(c.metrics.map((m) => m.employees));
          return (
            <div key={c.id} className="card cp-card">
              <div className="cp-card-head">
                <Pglyph p="li" size="lg" />
                <div className="cp-card-head-text">
                  <strong>{c.name ?? c.slug}</strong>
                  <div className="mono cp-handle">{c.industry ?? `linkedin.com/company/${c.slug}`}</div>
                </div>
                <button className="btn ghost sm" title="Stop tracking" onClick={() => void remove(c.id)}>
                  <Icon name="trash" size={11} />
                </button>
              </div>
              <div className="cp-stats">
                <div>
                  <div className="mono cp-stat-num">{c.followers.toLocaleString('en-US')}</div>
                  <div className="mono cp-stat-label">Followers {fGrowth !== 0 && <Delta pct={fGrowth} />}</div>
                </div>
                <div>
                  <div className="mono cp-stat-num">{c.employees.toLocaleString('en-US')}</div>
                  <div className="mono cp-stat-label">Employees {eGrowth !== 0 && <Delta pct={eGrowth} />}</div>
                </div>
                <Sparkline values={c.metrics.map((m) => m.followers ?? 0)} />
              </div>
              <div className="mono" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, color: 'var(--ink-4)', margin: '6px 0' }}>
                {c.headquarters && <span>📍 {c.headquarters}</span>}
                {c.foundedYear && <span>· est. {c.foundedYear}</span>}
                {c.website && <a href={c.website} target="_blank" rel="noreferrer">· site</a>}
              </div>
              {c.specialities.length > 0 && (
                <div className="sch-chip-row">
                  {c.specialities.slice(0, 6).map((s) => <span key={s} className="chip">{s}</span>)}
                </div>
              )}
            </div>
          );
        })}
        {companies.length === 0 && (
          <div className="apr-empty card" style={{ gridColumn: '1 / -1' }}>
            No LinkedIn companies tracked yet. Paste a company URL above, then hit Refresh.
          </div>
        )}
      </div>
    </div>
  );
};

export default LinkedInDashboard;
