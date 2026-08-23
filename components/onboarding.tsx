'use client';

import React, { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Icon, Pglyph } from './icons';
import { apiPatch, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT, SHORT_TO_PLATFORM } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';
import { estimateWeeklyBurn, weeksOfRunway, type ContentMixWeekly } from '../lib/credits/estimator';
import { BillingDetailsFields, useBillingDetails } from './billing/billing-details';
import type { CreditsPayload } from './credits';

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
  // Non-blocking save error surfaced in the footer. Cleared on the next
  // save attempt. When a PATCH rejects we keep the user on the current step
  // instead of silently advancing past an unsaved change.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Brand profile — flows into every AI surface (image, video, text).
  // The richer these fields are, the more on-brand the output. The same
  // fields are editable later from Auto-pilot → Brand profile.
  const [companyName, setCompanyName] = useState('');
  const [brandBio, setBrandBio] = useState('');
  const [website, setWebsite] = useState('');
  const [savingBrand, setSavingBrand] = useState(false);

  // Plan step state — what autopilot should actually do once enabled.
  const [planPlatforms, setPlanPlatforms] = useState<Platform[]>([]);
  const [planTextPerWeek, setPlanTextPerWeek] = useState<number>(3);
  const [planImagePerWeek, setPlanImagePerWeek] = useState<number>(1);
  const [planVideoPerWeek, setPlanVideoPerWeek] = useState<number>(0);
  const [planAutoPublish, setPlanAutoPublish] = useState<boolean>(false);
  const [planThreshold, setPlanThreshold] = useState<number>(90);
  const [savingPlan, setSavingPlan] = useState(false);

  const addCustomNiche = () => {
    const v = customNiche.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (!v) return;
    if (topics.includes(v)) { setCustomNiche(''); return; }
    setTopics((prev) => [...prev, v]);
    setCustomNiche('');
  };

  const { data: accounts, mutate: refetchAccounts, unauth } = useApi<Account[]>('/api/accounts');
  const { data: settings, mutate: refetchSettings } = useApi<{
    niches: string[];
    voiceTemplate: 'me' | 'punchy' | 'thoughtful' | 'data-led';
    companyName: string | null;
    brandBio: string | null;
    website: string | null;
    enabledPlatforms: Platform[];
    postsPerWeekByContentType: ContentMixWeekly;
    autoPublishThreshold: number;
  }>('/api/agent/settings');
  // Pulled into the Plan step's runway estimate.
  const { data: credits } = useApi<CreditsPayload>('/api/credits');

  // Hydrate form fields from the user's saved agent_settings on first load
  // (and when the settings object identity changes after a save). Intentional
  // sync from external store → React state.
  useEffect(() => {
    if (settings?.niches?.length) setTopics(settings.niches);
    if (settings?.voiceTemplate) setVoice(settings.voiceTemplate);
    if (settings?.companyName) setCompanyName(settings.companyName);
    if (settings?.brandBio) setBrandBio(settings.brandBio);
    if (settings?.website) setWebsite(settings.website);
    if (settings?.enabledPlatforms?.length) setPlanPlatforms(settings.enabledPlatforms);
    if (settings?.postsPerWeekByContentType) {
      setPlanTextPerWeek(settings.postsPerWeekByContentType.text ?? 3);
      setPlanImagePerWeek(settings.postsPerWeekByContentType.image ?? 1);
      setPlanVideoPerWeek(settings.postsPerWeekByContentType.video ?? 0);
    }
    if (typeof settings?.autoPublishThreshold === 'number') {
      const t = settings.autoPublishThreshold;
      setPlanAutoPublish(t <= 100);
      setPlanThreshold(Math.min(99, Math.max(70, t <= 100 ? t : 90)));
    }
  }, [settings]);

  // First time we have connected accounts, pre-check them for autopilot.
  // Only re-run on accounts change so we don't overwrite the user's
  // selection if they uncheck something after the initial seed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (planPlatforms.length === 0 && accounts && accounts.length > 0) {
      setPlanPlatforms(accounts.map((a) => a.platform));
    }
  }, [accounts]);

  // Company identity for GST invoices. Owns its own fetch/save; the Brand
  // step's Continue button drives it (see saveBrandAndContinue).
  const billing = useBillingDetails();

  const estimate = useMemo(() => estimateWeeklyBurn({
    platforms: planPlatforms,
    cadencePerWeek: planTextPerWeek + planImagePerWeek + planVideoPerWeek,
    postsPerWeekByContentType: {
      text: planTextPerWeek,
      image: planImagePerWeek,
      video: planVideoPerWeek,
    },
    withResearch: false,
  }), [planPlatforms, planTextPerWeek, planImagePerWeek, planVideoPerWeek]);

  const runwayWeeks = credits ? weeksOfRunway(estimate.weekly, credits.balance) : -1;
  const tierAllocation = credits?.monthlyAllocation ?? 0;
  const fitsTier = tierAllocation > 0 && estimate.weekly * 4 <= tierAllocation;

  const connectedShorts = (accounts ?? []).map((a) => PLATFORM_TO_SHORT[a.platform]);

  const startConnect = (platform: Platform) => {
    if (typeof window !== 'undefined') {
      window.location.assign(`/api/oauth/${platform}/start?next=/onboarding`);
    }
  };

  const toggleTopic = (id: string) => {
    setTopics((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const errText = (e: unknown) => (e instanceof Error ? e.message.slice(0, 140) : 'Something went wrong saving your changes.');

  const saveTopicsAndContinue = async () => {
    setSavingTopics(true);
    setSaveError(null);
    try {
      await apiPatch('/api/agent/settings', { niches: topics });
      await refetchSettings();
      setStep(2);
    } catch (e) {
      // Surface the failure and stay on this step — don't lose the change.
      setSaveError(`Couldn't save your niches: ${errText(e)}`);
    } finally {
      setSavingTopics(false);
    }
  };

  const saveVoiceAndContinue = async () => {
    setSavingVoice(true);
    setSaveError(null);
    try {
      await apiPatch('/api/agent/settings', { voiceTemplate: voice });
      await refetchSettings();
      setStep(3);
    } catch (e) {
      setSaveError(`Couldn't save your style: ${errText(e)}`);
    } finally {
      setSavingVoice(false);
    }
  };

  const saveBrandAndContinue = async () => {
    setSavingBrand(true);
    setSaveError(null);
    try {
      // Billing details first: a bad GSTIN is the one thing on this step that
      // can be *wrong* rather than just empty, and we'd rather not advance past
      // it having silently saved the brand fields around it.
      const billingError = await billing.save();
      if (billingError) {
        setSaveError(billingError);
        return;
      }
      await apiPatch('/api/agent/settings', {
        companyName: companyName.trim() || undefined,
        brandBio: brandBio.trim() || undefined,
        website: website.trim() || undefined,
      });
      await refetchSettings();
      setStep(4);
    } catch (e) {
      setSaveError(`Couldn't save your brand profile: ${errText(e)}`);
    } finally {
      setSavingBrand(false);
    }
  };

  const savePlanAndContinue = async () => {
    setSavingPlan(true);
    setSaveError(null);
    try {
      // We don't yet split per-platform caps in the Plan step — that's a
      // fine-tuning surface on the /agent page. For now we save the total
      // cadence + enabledPlatforms + per-type mix + auto-publish setting.
      const totalPerWeek = Math.max(1, planTextPerWeek + planImagePerWeek + planVideoPerWeek);
      await apiPatch('/api/agent/settings', {
        enabledPlatforms: planPlatforms,
        cadencePerWeek: totalPerWeek,
        postsPerWeekByContentType: {
          text: planTextPerWeek,
          image: planImagePerWeek,
          video: planVideoPerWeek,
        },
        // 101 = drafts-only (unreachable score). Anything ≤ 100 means
        // "auto-publish if the AI scores the draft above this threshold."
        autoPublishThreshold: planAutoPublish ? planThreshold : 101,
      });
      await refetchSettings();
      setStep(5);
    } catch (e) {
      setSaveError(`Couldn't save your plan: ${errText(e)}`);
    } finally {
      setSavingPlan(false);
    }
  };

  const finish = async () => {
    setEnabling(true);
    setSaveError(null);
    try {
      await apiPatch('/api/agent/settings', { enabled: true });
      onDone();
    } catch (e) {
      // "Enter Sociafy" is the button that turns autopilot ON. Walking the
      // user into the dashboard with it still off — and saying nothing — meant
      // they'd wait days for posts that were never coming.
      setSaveError(`Couldn't enable autopilot: ${errText(e)}`);
    } finally {
      setEnabling(false);
    }
  };

  const steps = [
    { num: 1, label: 'Connect' },
    { num: 2, label: 'Niches' },
    { num: 3, label: 'Style' },
    { num: 4, label: 'Brand' },
    { num: 5, label: 'Plan' },
    { num: 6, label: 'Ready' },
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
            You aren&apos;t signed in. <Link href="/sign-in?next=/onboarding" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>Sign in</Link> to connect your accounts.
          </div>
        )}

        {step === 0 && (
          <>
            <h1>Connect the channels.<br />I&apos;ll handle the <em>rest</em>.</h1>
            <p className="lede">
              Sociafy needs publish access so it can schedule on your behalf. You can revoke any time. If a platform isn&apos;t configured yet, we&apos;ll connect a demo-only account (won&apos;t post) so you can keep exploring.
            </p>
            <div className="connect-grid">
              {ONBOARD_PLATFORMS.map((p) => {
                const isConnected = connectedShorts.includes(p.short);
                const acct = accounts?.find((a) => a.platform === p.id);
                return (
                  <button
                    type="button"
                    key={p.id}
                    className={`connect-tile ${isConnected ? 'connected' : ''}`}
                    onClick={() => !isConnected && startConnect(p.id)}
                    disabled={isConnected}
                  >
                    <Pglyph p={p.short} size="xl" />
                    <div className="connect-tile-meta">
                      <div className="connect-tile-name">{p.name}</div>
                      <div className="connect-tile-handle">
                        {isConnected ? (acct?.handle ? `@${acct.handle}` : 'Connected') : 'Not connected'}
                        {acct?.isStub && <span className="chip ghost mono" style={{ marginLeft: 6 }}>Demo only</span>}
                      </div>
                    </div>
                    <div className="connect-tile-action">
                      {isConnected ? <><Icon name="check" size={12} /> Connected</> : <>Connect <Icon name="arrow_right" size={12} /></>}
                    </div>
                  </button>
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
                <button
                  type="button"
                  key={t.id}
                  className={`topic ${topics.includes(t.id) ? 'active' : ''}`}
                  onClick={() => toggleTopic(t.id)}
                  aria-pressed={topics.includes(t.id)}
                >
                  <span className="topic-label">{t.label}</span>
                  <span className="topic-sub">{t.sub}</span>
                </button>
              ))}
              {topics.filter((t) => !TOPICS.some((p) => p.id === t)).map((custom) => (
                <button type="button" key={custom} className="topic active" onClick={() => toggleTopic(custom)} aria-pressed>
                  <span className="topic-label">{custom}</span>
                  <span className="topic-sub">custom</span>
                </button>
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
                <button
                  type="button"
                  key={v.id}
                  className={`voice ${voice === v.id ? 'active' : ''}`}
                  onClick={() => setVoice(v.id)}
                  aria-pressed={voice === v.id}
                >
                  <div className="voice-name">{v.name}</div>
                  <div className="voice-desc">{v.desc}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1>Tell me about your <em>business</em>.</h1>
            <p className="lede">
              The richer this is, the more on-brand every image, video, and caption Sociafy generates. All three flow into the system prompt of every AI call. Editable later in Auto-pilot → Brand profile.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 32 }}>
              <div>
                <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Company / brand name</div>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Sociafy"
                  style={{ width: '100%', padding: '12px 14px', border: '1px solid var(--line-2)', borderRadius: 10, fontSize: 14, background: 'var(--bg-elev)', color: 'var(--ink)', outline: 'none', fontFamily: 'inherit' }}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>What do you do? <span style={{ textTransform: 'none', color: 'var(--ink-4)', fontWeight: 400 }}>· Be specific. Audience, what you sell, what makes you different.</span></div>
                <textarea
                  value={brandBio}
                  onChange={(e) => setBrandBio(e.target.value)}
                  maxLength={2000}
                  placeholder="We help solo founders turn one idea into on-brand posts, images, and Shorts across every platform. Voice is calm and direct — never hype-y, never corporate. We sell a $19/mo SaaS that automates the whole social media loop."
                  style={{ width: '100%', minHeight: 160, padding: 14, border: '1px solid var(--line-2)', borderRadius: 10, fontSize: 13.5, background: 'var(--bg-elev)', color: 'var(--ink)', outline: 'none', fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.55 }}
                />
                <div style={{ fontSize: 11, color: brandBio.length >= 1800 ? 'var(--bad)' : 'var(--ink-4)', fontFamily: 'var(--mono)', marginTop: 4, textAlign: 'right' }}>
                  {brandBio.length} / 2000
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Website</div>
                <input
                  type="url"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://sociafy.app"
                  style={{ width: '100%', padding: '12px 14px', border: '1px solid var(--line-2)', borderRadius: 10, fontSize: 14, background: 'var(--bg-elev)', color: 'var(--ink)', outline: 'none', fontFamily: 'var(--mono)' }}
                />
              </div>
            </div>
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 24, marginBottom: 32 }}>
              <h2 style={{ fontSize: 16, margin: '0 0 6px' }}>Invoicing details</h2>
              <p className="lede" style={{ marginTop: 0, marginBottom: 20 }}>
                So every payment gets a proper GST invoice in your business&apos;s name. You can skip this now and add it on the Billing page — but we can only put a GSTIN on invoices raised <em>after</em> you&apos;ve entered it.
              </p>
              <BillingDetailsFields value={billing.value} set={billing.set} setAddress={billing.setAddress} />
            </div>

            <div style={{ padding: 14, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12, color: 'var(--ink-3)', display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 32 }}>
              <Icon name="folder" size={14} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
              <span><strong style={{ color: 'var(--ink)' }}>Coming soon:</strong> upload PDFs / docs about your business — pitch decks, brand guidelines, product specs — and Sociafy will use them as long-term context for every AI call.</span>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h1>How should autopilot <em>behave</em>?</h1>
            <p className="lede">
              Where can it post, how often, and what mix? You can change this anytime from the Auto-pilot page. We recommend starting with drafts only — review each one before it goes live.
            </p>

            <div className="onboard-plan">
              <section className="plan-card">
                <div className="plan-card-head">
                  <div>
                    <h3 className="plan-card-title">1 · Platforms</h3>
                    <div className="plan-card-sub">Pick the channels autopilot is allowed to post on. We pre-checked your connected accounts.</div>
                  </div>
                </div>
                <div className="plan-platform-grid">
                  {ONBOARD_PLATFORMS.map((p) => {
                    const isConnected = connectedShorts.includes(p.short);
                    const selected = planPlatforms.includes(p.id);
                    return (
                      <button
                        type="button"
                        key={p.id}
                        className={`plan-platform ${selected ? 'on' : ''} ${!isConnected ? 'muted' : ''}`}
                        onClick={() => {
                          if (!isConnected) return;
                          setPlanPlatforms((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id]);
                        }}
                        title={isConnected ? p.name : `Connect ${p.name} first`}
                      >
                        <Pglyph p={p.short} size="lg" />
                        <span className="plan-platform-name">{p.name}</span>
                        {!isConnected && <span className="plan-platform-tag mono">connect first</span>}
                        {isConnected && selected && <Icon name="check" size={12} />}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="plan-card">
                <div className="plan-card-head">
                  <div>
                    <h3 className="plan-card-title">2 · Cadence + mix</h3>
                    <div className="plan-card-sub">How many posts per week of each kind. Defaults are conservative — autopilot fans these out across your selected platforms.</div>
                  </div>
                  <div className="plan-total mono">{estimate.totalPosts} / week</div>
                </div>
                <div className="plan-sliders">
                  <PlanSlider
                    label="Text posts" sub="caption only · cheapest"
                    value={planTextPerWeek} min={0} max={14}
                    onChange={setPlanTextPerWeek}
                  />
                  <PlanSlider
                    label="Image posts" sub="caption + one generated image"
                    value={planImagePerWeek} min={0} max={14}
                    onChange={setPlanImagePerWeek}
                  />
                  <PlanSlider
                    label="Video posts" sub="caption + one short reel · priciest"
                    value={planVideoPerWeek} min={0} max={7}
                    onChange={setPlanVideoPerWeek}
                  />
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 10, lineHeight: 1.5 }}>
                  Exact credit cost depends on the post type — see the live estimate below. Autopilot fans each post out across your selected platforms.
                </div>
              </section>

              <section className="plan-card">
                <div className="plan-card-head">
                  <div>
                    <h3 className="plan-card-title">3 · Auto-publish?</h3>
                    <div className="plan-card-sub">Recommended: drafts only — autopilot fills your inbox, you approve each one before it goes live.</div>
                  </div>
                </div>
                <div className="plan-radio-group">
                  <label className={`plan-radio ${!planAutoPublish ? 'on' : ''}`}>
                    <input type="radio" checked={!planAutoPublish} onChange={() => setPlanAutoPublish(false)} />
                    <div>
                      <div className="plan-radio-title"><Icon name="edit" size={11} /> Draft &amp; review <span className="plan-radio-pill mono">recommended</span></div>
                      <div className="plan-radio-sub">Autopilot drafts every post and parks it in your inbox. You hit publish.</div>
                    </div>
                  </label>
                  <label className={`plan-radio ${planAutoPublish ? 'on' : ''}`}>
                    <input type="radio" checked={planAutoPublish} onChange={() => setPlanAutoPublish(true)} />
                    <div>
                      <div className="plan-radio-title"><Icon name="bolt" size={11} /> Auto-publish high-confidence drafts</div>
                      <div className="plan-radio-sub">When autopilot scores a draft above your threshold, it schedules without asking.</div>
                      {planAutoPublish && (
                        <div className="plan-threshold">
                          <span className="mono">Threshold</span>
                          <input
                            type="range" min={70} max={99}
                            value={planThreshold}
                            onChange={(e) => setPlanThreshold(parseInt(e.target.value, 10))}
                          />
                          <span className="mono strong">≥ {planThreshold} / 100</span>
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              </section>

              <section className="plan-estimate">
                <div className="plan-estimate-num mono">
                  <span className="big">{estimate.weekly.toLocaleString()}</span>
                  <span className="muted"> credits / week</span>
                  <span className="muted" style={{ fontSize: 11 }}> · across {planPlatforms.length || 0} platform{planPlatforms.length === 1 ? '' : 's'}</span>
                </div>
                <div className="plan-estimate-meta mono">
                  {credits ? (
                    <>
                      Balance {credits.balance.toLocaleString()} · {runwayWeeks > 0 ? `${runwayWeeks} weeks runway at this rate` : estimate.weekly === 0 ? 'no autopilot spend' : 'top up to keep autopilot running'}
                      {tierAllocation > 0 && (
                        <> · {fitsTier ? '✓ fits monthly tier' : <span className="danger">over your monthly allocation</span>}</>
                      )}
                    </>
                  ) : '— loading balance —'}
                </div>
                <div className="plan-estimate-bars">
                  <div className="bar-row"><span className="bar-label">Text</span><span className="bar-track"><span className="bar-fill text" style={{ width: `${barPct(estimate.byKind.text, estimate.weekly)}%` }} /></span><span className="bar-val mono">{estimate.byKind.text}</span></div>
                  <div className="bar-row"><span className="bar-label">Image</span><span className="bar-track"><span className="bar-fill image" style={{ width: `${barPct(estimate.byKind.image, estimate.weekly)}%` }} /></span><span className="bar-val mono">{estimate.byKind.image}</span></div>
                  <div className="bar-row"><span className="bar-label">Video</span><span className="bar-track"><span className="bar-fill video" style={{ width: `${barPct(estimate.byKind.video, estimate.weekly)}%` }} /></span><span className="bar-val mono">{estimate.byKind.video}</span></div>
                </div>
              </section>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <h1>You&apos;re <em>ready</em>.</h1>
            <p className="lede">
              I&apos;ll start watching trends across your niches and drafting on the cadence you set. Hit &quot;Enter Sociafy&quot; to enable autopilot — you can pause it anytime from the topbar.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 32 }}>
              {[
                { label: `✓ Connected ${connectedShorts.length} platforms`, sub: connectedShorts.length ? connectedShorts.map((c) => ONBOARD_PLATFORMS.find((p) => p.short === c)?.name).join(' · ') : 'No accounts connected yet' },
                { label: `✓ Watching ${topics.length} niches`, sub: topics.join(' · ') || 'None selected' },
                { label: `✓ Style: ${VOICES.find((v) => v.id === voice)?.name ?? 'Custom'}`, sub: 'Tunable from the autopilot page' },
                { label: `✓ Brand: ${companyName || 'Not set'}`, sub: brandBio ? `${brandBio.slice(0, 80)}${brandBio.length > 80 ? '…' : ''}` : 'Add a brand bio anytime in Auto-pilot' },
                { label: `✓ Plan: ${estimate.totalPosts}/wk · ${planAutoPublish ? `auto ≥ ${planThreshold}` : 'drafts only'}`, sub: `~${estimate.weekly} credits / week · ${planPlatforms.length} platform${planPlatforms.length === 1 ? '' : 's'}` },
              ].map((row, i) => (
                <div key={i} style={{ padding: '14px 16px', background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 2 }}>{row.label}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{row.sub}</div>
                  </div>
                  <Icon name="check" size={14} style={{ color: 'var(--good)' }} />
                </div>
              ))}
            </div>
          </>
        )}

        {saveError && (
          <div role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', background: 'oklch(0.97 0.05 25)', border: '1px solid var(--bad)', borderRadius: 10, fontSize: 12.5, color: 'var(--ink)', marginBottom: 14 }}>
            <Icon name="alert" size={14} style={{ color: 'var(--bad)', flexShrink: 0, marginTop: 1 }} />
            <span style={{ flex: 1, lineHeight: 1.5 }}>{saveError} Your changes weren&apos;t saved — try Continue again.</span>
            <button className="btn ghost sm" onClick={() => setSaveError(null)} aria-label="Dismiss" style={{ padding: '2px 6px' }}>
              <Icon name="x" size={12} />
            </button>
          </div>
        )}

        <div className="onboard-foot">
          <button className="btn ghost" onClick={() => step > 0 && setStep(step - 1)} disabled={step === 0}>
            <Icon name="chevron_left" size={12} /> Back
          </button>
          <span className="onboard-skip mono">{step + 1} / 6</span>
          <button
            className="btn primary"
            onClick={async () => {
              if (step === 0) { await refetchAccounts(); setStep(1); }
              else if (step === 1) await saveTopicsAndContinue();
              else if (step === 2) await saveVoiceAndContinue();
              else if (step === 3) await saveBrandAndContinue();
              else if (step === 4) await savePlanAndContinue();
              else await finish();
            }}
            disabled={savingTopics || savingVoice || savingBrand || savingPlan || enabling}
          >
            {step === 5 ? (enabling ? 'Enabling…' : 'Enter Sociafy') :
              savingTopics || savingVoice || savingBrand || savingPlan ? 'Saving…' :
              'Continue'} <Icon name="arrow_right" size={12} />
          </button>
        </div>

        {/* Persistent escape hatch — a new user shouldn't be forced through
            6 steps + OAuth before seeing any value. Available on every step
            except the final "Ready" step (where the primary CTA already
            enters the app). */}
        {/* …and on the last step too when a save failed, so a broken PATCH
            can't trap the user on the final screen with no way into the app. */}
        {(step < 5 || !!saveError) && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button
              type="button"
              className="btn ghost sm"
              onClick={onDone}
              style={{ color: 'var(--ink-3)' }}
            >
              {step < 5 ? 'Skip setup' : 'Continue without autopilot'} <Icon name="arrow_right" size={11} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// Small helper used by the Plan step. Pulled out so the JSX above stays
// readable and so the estimator's bar chart has a single bar-percentage
// definition.
function barPct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

// Slider row for the Plan step's text/image/video cadence. Kept inline
// here because it has zero reuse outside this file.
const PlanSlider: React.FC<{
  label: string;
  sub: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}> = ({ label, sub, value, min, max, onChange }) => (
  <div className="plan-slider">
    <div className="plan-slider-head">
      <div>
        <div className="plan-slider-label">{label}</div>
        <div className="plan-slider-sub mono">{sub}</div>
      </div>
      <div className="plan-slider-val mono">{value}<span className="muted"> / wk</span></div>
    </div>
    <input
      type="range" min={min} max={max} value={value}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
    />
  </div>
);

export default Onboarding;

// Keep the platform map exposed for sibling imports
export { SHORT_TO_PLATFORM };
