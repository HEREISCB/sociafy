'use client';

import React, { Fragment, useEffect, useState } from 'react';
import { Icon, Pglyph } from './icons';
import { apiPatch, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT, SHORT_TO_PLATFORM } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';

const ONBOARD_PLATFORMS: { id: Platform; short: string; name: string }[] = [
  { id: 'x', short: 'x', name: 'X (Twitter)' },
  { id: 'linkedin', short: 'li', name: 'LinkedIn' },
  { id: 'instagram', short: 'ig', name: 'Instagram' },
  { id: 'facebook', short: 'fb', name: 'Facebook' },
  { id: 'tiktok', short: 'tt', name: 'TikTok' },
  { id: 'youtube', short: 'yt', name: 'YouTube' },
];

const TOPICS = [
  { id: 'saas', label: 'Solo SaaS', sub: 'founders, indie' },
  { id: 'creator-economy', label: 'Creator economy', sub: 'newsletters, audience' },
  { id: 'marketing', label: 'Indie marketing', sub: 'growth, GTM' },
  { id: 'ai', label: 'AI tooling', sub: 'agents, LLM ops' },
  { id: 'design', label: 'Design', sub: 'product, brand' },
  { id: 'devtools', label: 'Dev tools', sub: 'infra, OSS' },
  { id: 'fintech', label: 'Fintech', sub: 'payments, ops' },
  { id: 'media', label: 'Media', sub: 'podcasting, video' },
  { id: 'community', label: 'Community', sub: 'cohorts, events' },
];

const VOICES: { id: 'me' | 'punchy' | 'thoughtful' | 'data-led'; name: string; desc: string }[] = [
  { id: 'me', name: 'Adapt to my voice', desc: "Agent infers tone from your prompts and edits as you go. No retraining required." },
  { id: 'punchy', name: 'Punchy', desc: 'Short sentences, declarative, hook-first. Great for X.' },
  { id: 'thoughtful', name: 'Thoughtful', desc: 'Story-led, paragraph-y, takes time to land. LinkedIn-friendly.' },
  { id: 'data-led', name: 'Data-led', desc: 'Numbers and citations up front. Newsletter recap energy.' },
];

interface OnboardingProps {
  onDone: () => void;
}

type Account = {
  id: string;
  platform: Platform;
  handle: string | null;
  isStub: boolean;
};

const Onboarding: React.FC<OnboardingProps> = ({ onDone }) => {
  const [step, setStep] = useState(0);
  const [topics, setTopics] = useState<string[]>([]);
  const [customNiche, setCustomNiche] = useState('');
  const [voice, setVoice] = useState<'me' | 'punchy' | 'thoughtful' | 'data-led'>('me');
  const [savingTopics, setSavingTopics] = useState(false);
  const [savingVoice, setSavingVoice] = useState(false);
  const [enabling, setEnabling] = useState(false);

  const addCustomNiche = () => {
    const v = customNiche.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (!v) return;
    if (topics.includes(v)) { setCustomNiche(''); return; }
    setTopics((prev) => [...prev, v]);
    setCustomNiche('');
  };

  const { data: accounts, mutate: refetchAccounts, unauth } = useApi<Account[]>('/api/accounts');
  const { data: settings, mutate: refetchSettings } = useApi<{ niches: string[]; voiceTemplate: 'me' | 'punchy' | 'thoughtful' | 'data-led' }>('/api/agent/settings');

  useEffect(() => {
    if (settings?.niches?.length) setTopics(settings.niches);
    if (settings?.voiceTemplate) setVoice(settings.voiceTemplate);
  }, [settings]);

  const connectedShorts = (accounts ?? []).map((a) => PLATFORM_TO_SHORT[a.platform]);

  const startConnect = (platform: Platform) => {
    window.location.href = `/api/oauth/${platform}/start?next=/onboarding`;
  };

  const toggleTopic = (id: string) => {
    setTopics((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const saveTopicsAndContinue = async () => {
    setSavingTopics(true);
    try {
      await apiPatch('/api/agent/settings', { niches: topics });
      await refetchSettings();
      setStep(2);
    } catch {
      // ignore — keep them in flow
      setStep(2);
    } finally {
      setSavingTopics(false);
    }
  };

  const saveVoiceAndContinue = async () => {
    setSavingVoice(true);
    try {
      await apiPatch('/api/agent/settings', { voiceTemplate: voice });
      await refetchSettings();
      setStep(3);
    } catch {
      setStep(3);
    } finally {
      setSavingVoice(false);
    }
  };

  const finish = async () => {
    setEnabling(true);
    try {
      await apiPatch('/api/agent/settings', { enabled: true });
    } catch {
      // continue regardless
    }
    setEnabling(false);
    onDone();
  };

  const steps = [
    { num: 1, label: 'Connect' },
    { num: 2, label: 'Niches' },
    { num: 3, label: 'Style' },
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

        {unauth && (
          <div style={{ padding: 12, background: 'rgba(124,77,255,0.05)', border: '1px solid rgba(124,77,255,0.2)', borderRadius: 10, fontSize: 13, marginBottom: 18 }}>
            You aren&apos;t signed in. <a href="/sign-in?next=/onboarding" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>Sign in</a> to connect your accounts.
          </div>
        )}

        {step === 0 && (
          <>
            <h1>Connect the channels.<br />I&apos;ll handle the <em>rest</em>.</h1>
            <p className="lede">
              Sociafy needs publish access so it can schedule on your behalf. You can revoke any time. If a platform isn&apos;t configured yet, we&apos;ll connect a stub account so you can keep exploring.
            </p>
            <div className="connect-grid">
              {ONBOARD_PLATFORMS.map((p) => {
                const isConnected = connectedShorts.includes(p.short);
                const acct = accounts?.find((a) => a.platform === p.id);
                return (
                  <div
                    key={p.id}
                    className={`connect-tile ${isConnected ? 'connected' : ''}`}
                    onClick={() => !isConnected && startConnect(p.id)}
                  >
                    <Pglyph p={p.short} size="xl" />
                    <div className="connect-tile-meta">
                      <div className="connect-tile-name">{p.name}</div>
                      <div className="connect-tile-handle">
                        {isConnected ? (acct?.handle ? `@${acct.handle}` : 'Connected') : 'Not connected'}
                        {acct?.isStub && <span className="chip ghost mono" style={{ marginLeft: 6 }}>stub</span>}
                      </div>
                    </div>
                    <div className="connect-tile-action">
                      {isConnected ? <><Icon name="check" size={12} /> Connected</> : <>Connect <Icon name="arrow_right" size={12} /></>}
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
              Pick the niches that matter to your audience. I&apos;ll pull trends and surface only the strongest signals. You can change this anytime.
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
              {topics.filter((t) => !TOPICS.some((p) => p.id === t)).map((custom) => (
                <div key={custom} className="topic active" onClick={() => toggleTopic(custom)}>
                  <span className="topic-label">{custom}</span>
                  <span className="topic-sub">custom</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <input
                type="text"
                value={customNiche}
                onChange={(e) => setCustomNiche(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomNiche(); } }}
                placeholder="Add your own niche — e.g. real estate, prompt engineering, climate tech…"
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  border: '1px solid var(--line-2)',
                  borderRadius: 10,
                  fontSize: 13.5,
                  background: 'var(--bg-elev)',
                  color: 'var(--ink)',
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
              <button className="btn" onClick={addCustomNiche} disabled={!customNiche.trim()}>
                <Icon name="plus" size={12} /> Add
              </button>
            </div>
            <div style={{ padding: 14, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12.5, color: 'var(--ink-3)', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 32 }}>
              <Icon name="bolt" size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span>I&apos;ll pull from RSS feeds and rank items by recency + signal across your <strong style={{ color: 'var(--ink)' }}>{topics.length || '0'}</strong> niches.</span>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Pick a starting <em>style</em>.</h1>
            <p className="lede">
              I&apos;ll adapt as you edit. This is just a starting prompt — change it anytime in agent settings.
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
          </>
        )}

        {step === 3 && (
          <>
            <h1>You&apos;re <em>ready</em>.</h1>
            <p className="lede">
              I&apos;ll start watching trends across your niches and drafting on the cadence you set. Hit &quot;Enter Sociafy&quot; to enable autopilot — or skip and stay in co-pilot mode.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
              {[
                { label: `✓ Connected ${connectedShorts.length} platforms`, sub: connectedShorts.length ? connectedShorts.map((c) => ONBOARD_PLATFORMS.find((p) => p.short === c)?.name).join(' · ') : 'No accounts connected yet' },
                { label: `✓ Watching ${topics.length} niches`, sub: topics.join(' · ') || 'None selected' },
                { label: `✓ Style: ${VOICES.find((v) => v.id === voice)?.name ?? 'Custom'}`, sub: 'Tunable from the autopilot page' },
                { label: '→ Drafting cadence: 4 / week', sub: 'Adjustable in autopilot settings' },
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
          <button
            className="btn primary"
            onClick={async () => {
              if (step === 0) { await refetchAccounts(); setStep(1); }
              else if (step === 1) await saveTopicsAndContinue();
              else if (step === 2) await saveVoiceAndContinue();
              else await finish();
            }}
            disabled={savingTopics || savingVoice || enabling}
          >
            {step === 3 ? (enabling ? 'Enabling…' : 'Enter Sociafy') :
              savingTopics || savingVoice ? 'Saving…' :
              'Continue'} <Icon name="arrow_right" size={12} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;

// Keep the platform map exposed for sibling imports
export { SHORT_TO_PLATFORM };
