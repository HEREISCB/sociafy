'use client';

import React, { useEffect, useState } from 'react';
import { Icon } from './icons';
import { apiPatch, apiPost, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { healthFor } from '../lib/ui/health';
import { defaultMix } from '../lib/ui/platforms';
import ConnectionsList, { isHealthy, useNow, useOAuthReturn, type Account } from './connections-list';

const TOPICS = [
  { id: 'saas', label: 'Solo SaaS' },
  { id: 'creator-economy', label: 'Creator economy' },
  { id: 'marketing', label: 'Indie marketing' },
  { id: 'ai', label: 'AI tooling' },
  { id: 'design', label: 'Design' },
  { id: 'devtools', label: 'Dev tools' },
  { id: 'fintech', label: 'Fintech' },
  { id: 'media', label: 'Media' },
  { id: 'community', label: 'Community' },
];

const STEPS = ['Connect', 'Topics', 'First week'];

// Survives the OAuth round-trip and reloads, so nobody restarts at step 1.
const STEP_KEY = 'sociafy:onboardingStep';

/** "acme.com" → "https://acme.com"; the settings API wants a full URL. */
const normalizeUrl = (v: string) => {
  const t = v.trim();
  return !t || /^https?:\/\//i.test(t) ? t : `https://${t}`;
};

const Onboarding: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [step, setStepState] = useState(0);
  const setStep = (n: number) => {
    window.sessionStorage.setItem(STEP_KEY, String(n));
    setStepState(n);
  };
  // Back from OAuth → the Connect step; a plain reload → where they were.
  const { flash, dismiss } = useOAuthReturn((fromOAuth) => {
    const saved = Number(window.sessionStorage.getItem(STEP_KEY));
    if (fromOAuth) window.sessionStorage.setItem(STEP_KEY, '0');
    else if (saved > 0 && saved <= STEPS.length - 1) setStepState(saved);
  });

  const [topics, setTopics] = useState<string[]>([]);
  const [customNiche, setCustomNiche] = useState('');
  const [website, setWebsite] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: accounts } = useApi<Account[]>('/api/accounts');
  const { data: settings } = useApi<{ niches: string[]; website: string | null }>('/api/agent/settings');
  const now = useNow();

  // Hydrate from saved settings (a reload mid-setup keeps earlier answers).
  useEffect(() => {
    if (!settings) return;
    queueMicrotask(() => {
      if (settings.niches?.length) setTopics(settings.niches);
      if (settings.website) setWebsite(settings.website);
    });
  }, [settings]);

  // Only accounts that can publish count, and only those get posted to.
  const platforms = (accounts ?? []).filter((a) => isHealthy(healthFor(a, now))).map((a) => a.platform);
  const mix = defaultMix(platforms);
  const perWeek = mix.text + mix.image + mix.video;

  const toggleTopic = (id: string) =>
    setTopics((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const addCustomNiche = () => {
    const v = customNiche.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (!v) return;
    // A niche is what we search trends for; a sentence or a URL only pulls in noise.
    if (v.split('-').length > 4 || /[.,]/.test(v)) {
      setError('Keep a topic short, like "voice ai" or "b2b sales". Your website has its own field below.');
      return;
    }
    setError(null);
    if (!topics.includes(v)) setTopics((prev) => [...prev, v]);
    setCustomNiche('');
  };

  const leave = () => {
    window.sessionStorage.removeItem(STEP_KEY);
    onDone();
  };

  const saveTopics = async () => {
    if (topics.length === 0) {
      setError('Pick at least one topic. It is what Sociafy writes about.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPatch('/api/agent/settings', { niches: topics, website: normalizeUrl(website) });
      setStep(2);
    } catch (e) {
      setError(`Couldn't save your topics. ${friendlyApiError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // The only PATCH that sends enabled:true — that is what stamps onboardedAt.
  const planWeek = async () => {
    if (platforms.length === 0) {
      setError('Connect at least one account first.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPatch('/api/agent/settings', {
        enabledPlatforms: platforms,
        postsPerWeekByContentType: mix,
        autoPublishThreshold: 101, // review-first: nothing posts until approved
        planHorizonDays: 7,
        enabled: true,
      });
    } catch (e) {
      setError(`Couldn't save your plan. ${friendlyApiError(e)}`);
      setSaving(false);
      return;
    }
    // Home shows the plan drafting either way; a 409 (already running) is fine.
    await apiPost('/api/plan/generate', { horizonDays: 7 }).catch(() => {});
    leave();
  };

  return (
    <div className="onboard">
      <div className="onboard-inner">
        <div className="brand onboard-brand">
          <div className="brand-mark">S</div>
          <span className="brand-name">sociafy<span className="dot">.</span></span>
        </div>

        <ol className="onboard-steps" aria-label="Setup progress">
          {STEPS.map((label, i) => (
            <li key={label} className={i === step ? 'is-current' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>
              {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <h1>Connect your accounts</h1>
            <p className="lede">Sociafy posts only what you approve. You can disconnect any time.</p>
            <ConnectionsList mode="onboarding" next="/onboarding" flash={flash} onDismissFlash={dismiss} />
          </>
        )}

        {step === 1 && (
          <>
            <h1>What do you post about?</h1>
            <p className="lede">Pick a few topics. You can change them later.</p>
            <div className="topic-chips">
              {[...TOPICS, ...topics.filter((t) => !TOPICS.some((p) => p.id === t)).map((t) => ({ id: t, label: t.replace(/-/g, ' ') }))].map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="topic-chip"
                  onClick={() => toggleTopic(t.id)}
                  aria-pressed={topics.includes(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <form className="row onboard-field" onSubmit={(e) => { e.preventDefault(); addCustomNiche(); }}>
              <input
                className="input"
                aria-label="Add your own topic"
                value={customNiche}
                onChange={(e) => setCustomNiche(e.target.value)}
                placeholder="Add your own, e.g. climate tech"
              />
              <button type="submit" className="btn" disabled={!customNiche.trim()}>Add</button>
            </form>
            <label className="onboard-label" htmlFor="onboard-website">Website <span>(optional)</span></label>
            <input
              id="onboard-website"
              className="input onboard-field"
              type="text"
              inputMode="url"
              autoComplete="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="yourcompany.com"
            />
          </>
        )}

        {step === 2 && (
          <>
            <h1>Plan your first week</h1>
            <p className="lede">
              {platforms.length === 0
                ? 'Connect an account first, then come back here.'
                : `Sociafy will draft about ${perWeek} post${perWeek === 1 ? '' : 's'} for the next 7 days. Nothing goes out until you approve it.`}
            </p>
          </>
        )}

        {error && (
          <div role="alert" className="conn-banner conn-banner--err">
            <span className="conn-banner__text">{error}</span>
            <button type="button" className="btn ghost sm" onClick={() => setError(null)} aria-label="Dismiss">
              <Icon name="x" size={12} />
            </button>
          </div>
        )}

        <div className="onboard-foot">
          {step > 0 ? (
            <button type="button" className="btn ghost" onClick={() => { setError(null); setStep(step - 1); }} disabled={saving}>
              Back
            </button>
          ) : <span />}
          <div className="row">
            <button type="button" className="btn ghost onboard-skip" onClick={leave} disabled={saving}>
              Skip for now
            </button>
            {step === 0 && (
              <button type="button" className="btn primary" onClick={() => setStep(1)} disabled={platforms.length === 0}>
                Continue
              </button>
            )}
            {step === 1 && (
              <button type="button" className="btn primary" onClick={saveTopics} disabled={saving}>
                {saving ? 'Saving…' : 'Continue'}
              </button>
            )}
            {step === 2 && (
              <button type="button" className="btn primary" onClick={planWeek} disabled={saving || platforms.length === 0}>
                {saving ? 'Planning…' : 'Draft my week'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
