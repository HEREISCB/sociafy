'use client';

import React, { Fragment, useState } from 'react';
import { Icon, Pglyph } from './icons';

const ONBOARD_PLATFORMS = [
  { id: 'x', name: 'X (Twitter)', handle: '@jordanmae' },
  { id: 'li', name: 'LinkedIn', handle: 'in/jordanmae' },
  { id: 'ig', name: 'Instagram', handle: '@jordan.mae' },
  { id: 'fb', name: 'Facebook', handle: 'Jordan Mae' },
  { id: 'tt', name: 'TikTok', handle: '@jordan.mae' },
  { id: 'yt', name: 'YouTube', handle: 'Jordan Mae' },
];

const TOPICS = [
  { id: 'saas', label: 'Solo SaaS', sub: 'founders, indie' },
  { id: 'creator', label: 'Creator economy', sub: 'newsletters, audience' },
  { id: 'marketing', label: 'Indie marketing', sub: 'growth, GTM' },
  { id: 'ai', label: 'AI tooling', sub: 'agents, LLM ops' },
  { id: 'design', label: 'Design', sub: 'product, brand' },
  { id: 'devtools', label: 'Dev tools', sub: 'infra, OSS' },
  { id: 'fintech', label: 'Fintech', sub: 'payments, ops' },
  { id: 'media', label: 'Media', sub: 'podcasting, video' },
  { id: 'community', label: 'Community', sub: 'cohorts, events' },
];

const VOICES = [
  { id: 'me', name: 'Sound like me', desc: 'Train on 20+ of my recent posts. Best fidelity to my actual voice.' },
  { id: 'punchy', name: 'Punchy', desc: 'Short sentences, declarative, hook-first. Great for X.' },
  { id: 'thoughtful', name: 'Thoughtful', desc: 'Story-led, paragraph-y, takes time to land. LinkedIn-friendly.' },
  { id: 'data', name: 'Data-led', desc: 'Numbers and citations up front. Newsletter recap energy.' },
];

interface OnboardingProps {
  onDone: () => void;
}

const Onboarding: React.FC<OnboardingProps> = ({ onDone }) => {
  const [step, setStep] = useState(0);
  const [connected, setConnected] = useState(['x', 'li']);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [topics, setTopics] = useState(['saas', 'creator']);
  const [voice, setVoice] = useState('me');

  const toggleConnect = (id: string) => {
    if (connected.includes(id)) {
      setConnected(connected.filter((x) => x !== id));
    } else {
      setConnecting(id);
      setTimeout(() => {
        setConnected((prev) => [...prev, id]);
        setConnecting(null);
      }, 700);
    }
  };

  const toggleTopic = (id: string) => {
    setTopics((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const steps = [
    { num: 1, label: 'Connect' },
    { num: 2, label: 'Niches' },
    { num: 3, label: 'Voice' },
    { num: 4, label: 'Ready' },
  ];

  return (
    <div className="onboard">
      <div className="onboard-inner">
        <div className="brand" style={{ padding: 0, marginBottom: 36 }}>
          <div className="brand-mark">S</div>
          <span className="brand-name">sociafy<span className="dot">.</span></span>
        </div>

        <div className="onboard-stepper">
          {steps.map((s, i) => (
            <Fragment key={s.num}>
              <div className={`step ${i < step ? 'done' : i === step ? 'current' : ''}`}>
                <span className="num">{i < step ? '✓' : s.num}</span>
                <span>{s.label}</span>
              </div>
              {i < steps.length - 1 && <span className="bar" />}
            </Fragment>
          ))}
        </div>

        {step === 0 && (
          <>
            <h1>Connect the channels.<br />I&apos;ll handle the <em>rest</em>.</h1>
            <p className="lede">
              Sociafy needs read &amp; publish access so it can read your last 90 days of posts, learn your voice, and schedule on your behalf. You can revoke any time.
            </p>
            <div className="connect-grid">
              {ONBOARD_PLATFORMS.map((p) => {
                const isConnected = connected.includes(p.id);
                const isConnecting = connecting === p.id;
                return (
                  <div
                    key={p.id}
                    className={`connect-tile ${isConnected ? 'connected' : ''} ${isConnecting ? 'connecting' : ''}`}
                    onClick={() => !isConnecting && toggleConnect(p.id)}
                  >
                    <Pglyph p={p.id} size="xl" />
                    <div className="connect-tile-meta">
                      <div className="connect-tile-name">{p.name}</div>
                      <div className="connect-tile-handle">{isConnected ? p.handle : 'Not connected'}</div>
                    </div>
                    <div className="connect-tile-action">
                      {isConnected ? <><Icon name="check" size={12} /> Connected</> :
                        isConnecting ? <>Connecting…</> :
                          <>Connect <Icon name="arrow_right" size={12} /></>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1>What should I <em>watch</em> for you?</h1>
            <p className="lede">
              Pick the niches that matter to your audience. I&apos;ll pull trends, news, and competitor signals from these so every draft is timely. You can change this anytime.
            </p>
            <div className="topic-grid">
              {TOPICS.map((t) => (
                <div
                  key={t.id}
                  className={`topic ${topics.includes(t.id) ? 'active' : ''}`}
                  onClick={() => toggleTopic(t.id)}
                >
                  <span className="topic-label">{t.label}</span>
                  <span className="topic-sub">{t.sub}</span>
                </div>
              ))}
            </div>
            <div style={{ padding: 14, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12.5, color: 'var(--ink-3)', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 32 }}>
              <Icon name="bolt" size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span>I&apos;ll fetch <strong style={{ color: 'var(--ink)' }}>~80 sources / day</strong> across your {topics.length} niches and surface only the top 5%.</span>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Pick a starting <em>voice</em>.</h1>
            <p className="lede">
              I&apos;ll fine-tune from here as you edit and approve drafts. The fastest path to &quot;feels like me&quot; is letting me train on your real posts — but you can always start from a template.
            </p>
            <div className="voice-grid">
              {VOICES.map((v) => (
                <div
                  key={v.id}
                  className={`voice ${voice === v.id ? 'active' : ''}`}
                  onClick={() => setVoice(v.id)}
                >
                  <div className="voice-name">{v.name}</div>
                  <div className="voice-desc">{v.desc}</div>
                </div>
              ))}
            </div>
            <div style={{ padding: 14, background: 'var(--bg-elev)', border: '1px dashed var(--line-2)', borderRadius: 10, fontSize: 12.5, color: 'var(--ink-3)', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 32 }}>
              <span className="chip ghost mono" style={{ background: 'var(--ink)', color: 'var(--bg)', borderColor: 'var(--ink)' }}>Soon</span>
              <span>Voice posts — turn any draft into a podcast clip with our TTS engine. We&apos;ll let you know when it ships.</span>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1>You&apos;re <em>ready</em>.</h1>
            <p className="lede">
              I&apos;ll spend the next ~5 minutes reading your last 90 days of posts, fetching today&apos;s trends, and drafting your first 3 posts. Want me to schedule them automatically once they&apos;re ready?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
              {[
                { label: '✓ Reading 47 of your recent posts', sub: 'Building voice profile v1' },
                { label: `✓ Connected ${connected.length} platforms`, sub: connected.map((c) => ONBOARD_PLATFORMS.find((p) => p.id === c)?.name).join(' · ') },
                { label: `✓ Watching ${topics.length} niches`, sub: `~${topics.length * 25} sources / day` },
                { label: '→ Drafting your first 3 posts', sub: 'Ready in ~4 min' },
              ].map((row, i) => (
                <div key={i} style={{ padding: '14px 16px', background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 2 }}>{row.label}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{row.sub}</div>
                  </div>
                  {i < 3
                    ? <Icon name="check" size={14} style={{ color: 'var(--good)' }} />
                    : <Icon name="refresh" size={14} style={{ color: 'var(--accent)' }} />}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="onboard-foot">
          <button className="btn ghost" onClick={() => step > 0 && setStep(step - 1)} disabled={step === 0}>
            <Icon name="chevron_left" size={12} /> Back
          </button>
          <span className="onboard-skip mono">{step + 1} / 4</span>
          <button className="btn primary" onClick={() => step < 3 ? setStep(step + 1) : onDone()}>
            {step === 3 ? 'Enter Sociafy' : 'Continue'} <Icon name="arrow_right" size={12} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
