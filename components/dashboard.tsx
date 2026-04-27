'use client';

import React, { useState } from 'react';
import { Icon, Pglyph, Spark } from './icons';

const SAMPLE_QUEUE = [
  { id: 1, when: 'Today', time: '14:30', text: "The 3 metrics every solo founder should ignore (and the one you can't). A thread →", platforms: ['x', 'li'], status: 'scheduled', score: 92 },
  { id: 2, when: 'Today', time: '18:00', text: 'Behind the scenes of our new studio setup. Spent 3 weekends repainting and the light is finally right.', platforms: ['ig', 'fb'], status: 'ai', score: 88 },
  { id: 3, when: 'Tomorrow', time: '09:15', text: "Hot take: most \"personal branding\" advice is just polished gatekeeping. Here's what actually moves the needle in 2026.", platforms: ['li', 'x'], status: 'draft', score: 76 },
  { id: 4, when: 'Tomorrow', time: '12:45', text: 'A 90-second tour of how we ship features without standups. Reels carousel attached.', platforms: ['ig', 'tt', 'yt'], status: 'ai', score: 81 },
  { id: 5, when: 'Wed', time: '08:00', text: 'Newsletter recap: 5 small studios that grew past $1M ARR last quarter. Linking the full breakdown.', platforms: ['li', 'x', 'fb'], status: 'scheduled', score: 84 },
];

const TRENDS = [
  { rank: 1, title: 'Rise of "agentic content" workflows', vol: '24.1k', delta: '+312%', niche: 'Marketing' },
  { rank: 2, title: '#BuildInPublic resurgence on LinkedIn', vol: '18.7k', delta: '+148%', niche: 'Founders' },
  { rank: 3, title: 'Vertical video gets a comeback on X', vol: '12.3k', delta: '+96%', niche: 'Creator' },
  { rank: 4, title: 'AI voice notes outperform image posts', vol: '8.9k', delta: '+74%', niche: 'Industry' },
  { rank: 5, title: 'Substack vs newsletters in your CRM', vol: '6.4k', delta: '+41%', niche: 'B2B' },
];

interface DashboardProps {
  mode: string;
  onCompose: () => void;
}

const Dashboard: React.FC<DashboardProps> = ({ onCompose }) => {
  const [tab, setTab] = useState<'upcoming' | 'drafts' | 'posted'>('upcoming');

  const stats = [
    { label: 'Scheduled this week', value: '14', delta: '+3 vs last', up: true, spark: [4, 6, 5, 8, 7, 9, 11, 12, 14] },
    { label: 'Engagement (7d)', value: '8.2k', delta: '+18%', up: true, spark: [3, 4, 3, 6, 5, 7, 6, 9, 8] },
    { label: 'Reach (7d)', value: '142k', delta: '+24%', up: true, spark: [80, 90, 85, 110, 105, 125, 120, 135, 142] },
    { label: 'Agent autopilot', value: '64%', delta: '+12 saved hrs', up: true, spark: [40, 45, 50, 55, 52, 58, 60, 62, 64] },
  ];

  return (
    <>
      <div className="briefing">
        <div>
          <div className="briefing-eyebrow">
            <span className="pulse" />
            Morning briefing · Apr 27, 6:42 AM
          </div>
          <h2>
            Two trends in your niche are spiking this morning.{' '}
            <em>I drafted three posts and one short-video script for you to review.</em>
          </h2>
          <p>
            Agentic workflows mentions are up 312% since yesterday — your tone fits the conversation.
            I&apos;ve also queued a Wednesday recap pulling from your latest newsletter.
          </p>
          <div className="briefing-actions">
            <button className="btn accent" onClick={onCompose}>
              <Icon name="sparkle" size={13} /> Review 3 drafts
            </button>
            <button className="btn">
              <Icon name="trend" size={13} /> See full briefing
            </button>
            <button className="btn ghost" style={{ color: 'oklch(0.78 0 0)' }}>
              <Icon name="refresh" size={13} /> Refresh
            </button>
          </div>
        </div>
        <div className="briefing-meter">
          <div className="meter-tiny">Today&apos;s posting plan</div>
          <div className="meter-row"><span>Posts queued</span><strong>4 / 5</strong></div>
          <div className="meter-bar"><div className="fill" style={{ width: '80%' }} /></div>
          <div className="meter-row"><span>Niche signal</span><strong>Strong</strong></div>
          <div className="meter-bar"><div className="fill" style={{ width: '88%' }} /></div>
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
              <button className="btn sm"><Icon name="plus" size={12} /> New</button>
            </div>
          </div>
          <div className="card-body flush">
            {SAMPLE_QUEUE.map((q) => (
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
                    <span className="chip ghost mono">Score {q.score}</span>
                  </div>
                </div>
                <div className="queue-actions">
                  <button className="icon-btn" title="Edit"><Icon name="edit" size={13} /></button>
                  <button className="icon-btn" title="Reschedule"><Icon name="clock" size={13} /></button>
                  <button className="icon-btn" title="More"><Icon name="more" size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3><Icon name="fire" size={14} /> Trending in your niche</h3>
              <span className="meta">Refreshed 6m ago</span>
            </div>
            <div className="card-body flush">
              {TRENDS.map((t) => (
                <div className="trend-item" key={t.rank}>
                  <span className="trend-rank tnum">{String(t.rank).padStart(2, '0')}</span>
                  <div>
                    <div className="trend-title">{t.title}</div>
                    <div className="trend-sub">
                      {t.niche} · {t.vol} mentions{' '}
                      <span style={{ color: 'var(--good)' }}>{t.delta}</span>
                    </div>
                  </div>
                  <div className="trend-action">
                    <button className="btn sm"><Icon name="sparkle" size={11} /> Draft</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default Dashboard;
