'use client';

import React, { useState } from 'react';
import { Icon } from './icons';

const AGENT_FEED = [
  {
    id: 1,
    when: '2 min ago',
    kind: 'trend',
    title: 'Spotted a 312% spike in "agentic content" mentions',
    body: 'Marketing twitter is debating whether agent-driven posting is the new SEO. Your last 3 posts on adjacent topics averaged 2.1k impressions — well above your baseline.',
    actions: ['Draft a take', 'Mute topic', 'Schedule for peak window'],
    artifact: null,
  },
  {
    id: 2,
    when: '14 min ago',
    kind: 'queue',
    title: 'Drafted 3 posts based on your newsletter #47',
    body: "I pulled three angles from your \"compounding content\" essay. Variant B scored highest against your last 90 days of voice. Ready when you are.",
    actions: ['Review drafts', 'Auto-approve B', 'Skip this round'],
    artifact: { kind: 'posts', count: 3 },
  },
  {
    id: 3,
    when: '1 hr ago',
    kind: 'risk',
    title: 'Held a draft — tone mismatch',
    body: 'A scheduled LinkedIn post used "game-changing" twice. Your voice profile flags that phrase. Rewrote it and queued for your approval.',
    actions: ['See diff', 'Approve rewrite', 'Post original'],
    artifact: null,
  },
  {
    id: 4,
    when: '3 hr ago',
    kind: 'insight',
    title: "Reels at 6:30 PM are outperforming your 12:00 slot",
    body: "I shifted Wednesday's reel to 18:30 based on the last 4 weeks. Want me to do this automatically going forward?",
    actions: ['Yes, automate', 'Just this once', 'Show data'],
    artifact: null,
  },
];

const RULES = [
  { label: 'Post cadence', value: '4–5 / week', editable: true },
  { label: 'Auto-publish if score', value: '≥ 90 / 100', editable: true },
  { label: 'Brand-safe filter', value: 'Strict', editable: true },
  { label: 'Voice match', value: 'Trained on 47 posts', editable: false },
  { label: 'Quiet hours', value: '22:00 – 07:00', editable: true },
  { label: 'Topics to avoid', value: '3 keywords', editable: true },
];

const AgentPage: React.FC = () => {
  const [autopilot, setAutopilot] = useState(true);
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(
    'Lean into solo-founder and indie-marketing angles. Avoid hot takes on politics or layoffs. Prefer story-led posts on LinkedIn, punchy threads on X. Pull from my newsletter when possible. Never use "game-changing" or "synergy".'
  );

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
                  ? "I'm monitoring 4 niches, drafting daily, and posting within your guardrails."
                  : "I'll keep watching but won't draft or post without you."}
              </div>
            </div>
            <button className={`btn ${autopilot ? '' : 'primary'}`} onClick={() => setAutopilot(!autopilot)}>
              {autopilot ? <><Icon name="pause" size={12} /> Pause</> : <><Icon name="play" size={12} /> Resume</>}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="chat" size={14} />
              Agent instructions
              <span className="chip accent"><span className="dot" />Steers every draft</span>
            </h3>
            <button className="btn sm" onClick={() => setEditing(!editing)}>
              <Icon name={editing ? 'check' : 'edit'} size={11} /> {editing ? 'Save' : 'Edit'}
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
                {instructions}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 11.5, color: 'var(--ink-3)' }}>
              <span className="mono">Last updated 2 days ago · {instructions.length} chars</span>
              <button className="btn sm ghost"><Icon name="refresh" size={11} /> Re-run on queue</button>
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
            {AGENT_FEED.map((a) => (
              <div className="agent-card" key={a.id}>
                <div className="agent-mark">A</div>
                <div>
                  <div className="agent-meta">
                    <span>Agent</span>
                    <span style={{ color: 'var(--ink-4)' }}>·</span>
                    <span>{a.when}</span>
                    <span className={`chip ${a.kind === 'risk' ? 'warn' : a.kind === 'trend' ? 'accent' : ''}`}>
                      <span className="dot" />
                      {a.kind === 'queue' ? 'Drafted' : a.kind === 'risk' ? 'Held' : a.kind === 'trend' ? 'Trend' : 'Insight'}
                    </span>
                  </div>
                  <div className="agent-title">{a.title}</div>
                  <div className="agent-body">{a.body}</div>
                  {a.artifact && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                      {[1, 2, 3].map((i) => (
                        <div key={i} style={{ flex: 1, padding: 8, fontSize: 11, color: 'var(--ink-3)', background: 'var(--bg-sunk)', border: '1px dashed var(--line-2)', borderRadius: 6, fontFamily: 'var(--mono)' }}>
                          Variant {String.fromCharCode(64 + i)} · {[88, 92, 79][i - 1]}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="agent-actions">
                    {a.actions.map((act, i) => (
                      <button key={act} className={`btn sm ${i === 0 ? 'primary' : ''}`}>{act}</button>
                    ))}
                  </div>
                </div>
                <button className="icon-btn"><Icon name="x" size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3><Icon name="settings" size={14} /> Guardrails</h3>
            <button className="btn sm ghost"><Icon name="edit" size={11} /></button>
          </div>
          <div className="card-body flush">
            {RULES.map((r) => (
              <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{r.label}</span>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {r.value}
                  {r.editable && <Icon name="chevron_right" size={11} style={{ color: 'var(--ink-4)' }} />}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3><Icon name="globe" size={14} /> Niches I&apos;m watching</h3>
            <button className="btn sm"><Icon name="plus" size={11} /></button>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { name: 'Solo SaaS founders', signal: 'Strong', count: 412, peak: true },
              { name: 'Creator economy', signal: 'Strong', count: 287, peak: false },
              { name: 'Indie marketing', signal: 'Mid', count: 154, peak: false },
              { name: 'AI tooling', signal: 'Mid', count: 98, peak: false },
            ].map((n) => (
              <div key={n.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: 'var(--bg-sunk)' }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 500 }}>{n.name}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{n.count} sources · {n.signal} signal</div>
                </div>
                {n.peak && <span className="chip accent"><span className="dot" />Spiking</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3><Icon name="waveform" size={14} /> Voice training</h3>
            <span className="meta mono">v3 · 47 posts</span>
          </div>
          <div className="card-body">
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 12 }}>
              I match your tone with <strong>92% confidence</strong>. Add 8 more reference posts to push past 95%.
            </div>
            <div className="meter-bar" style={{ background: 'var(--bg-sunk)', height: 6 }}>
              <div className="fill" style={{ width: '92%', background: 'var(--accent)' }} />
            </div>
            <button className="btn sm" style={{ marginTop: 12 }}>
              <Icon name="upload" size={11} /> Import more posts
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentPage;
