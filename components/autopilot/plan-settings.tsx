'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { apiPatch, friendlyApiError, useApi } from '../../lib/ui/fetcher';
import type { Niche, Platform } from '../../lib/db/schema';
import type { AgentStatus } from '../../lib/agent/status';
import { estimateWeeklyBurn } from '../../lib/credits/estimator';
import { mixFor, platformCaps, presetOf, type MixPreset } from '../../lib/agent/recommend';

type Mix = { text: number; image: number; video: number };

type Settings = {
  enabled: boolean;
  instructions: string;
  autoPublishThreshold: number;
  brandSafetyStrict: boolean;
  niches: Niche[];
  quietHours: { start: string; end: string } | null;
  companyName: string | null;
  brandBio: string | null;
  website: string | null;
  enabledPlatforms: Platform[];
  postsPerWeekByContentType: Mix;
  weeklyCreditCap: number | null;
  planHorizonDays: number;
};

/** AgentStatus as it arrives over JSON — Dates are strings by then. */
type StatusPayload = Omit<AgentStatus, 'pendingReview'> & {
  pendingReview: { id: string; title: string | null; createdAt: string; rendering: boolean }[];
};

/** "Post automatically" threshold; new users start on 101 ("Ask me first"). */
const AUTO_THRESHOLD = 80;

const NICHE_LABELS: Record<string, string> = {
  saas: 'Solo SaaS founders',
  'creator-economy': 'Creator economy',
  marketing: 'Indie marketing',
  ai: 'AI tooling',
  design: 'Design',
  devtools: 'Dev tools',
  fintech: 'Fintech',
  media: 'Media',
  community: 'Community',
};

const PLATFORM_NAMES: Record<Platform, string> = {
  x: 'X', linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', reddit: 'Reddit',
};

const BLOCKED: Record<NonNullable<AgentStatus['blocked']>, { text: string; href?: string; cta: string }> = {
  no_niches: { text: 'Pick at least one topic.', cta: 'Topics', href: '#ap-topics' },
  no_platforms: { text: 'No connected account is switched on.', cta: 'Connections', href: '/settings/connections' },
  no_credits: { text: 'Out of credits.', cta: 'Top up', href: '/settings/plan' },
  credit_cap: { text: 'Weekly credit cap reached.', cta: 'Raise the cap', href: '#ap-advanced' },
  no_trends: { text: 'Nothing fresh in your topics yet. It checks again every hour.', cta: 'Edit topics', href: '#ap-topics' },
};

const PRESETS: { id: MixPreset; label: string }[] = [
  { id: 'text', label: 'Text only' },
  { id: 'mixed', label: 'Mixed' },
  { id: 'video', label: 'Video-first' },
];

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** A two-or-three way choice. `.mode-switch` primitive, as a radio group. */
function Choice<T extends string | number>({ label, value, options, disabled, onChange }: {
  label: string;
  value: T | null;
  options: { id: T; label: string }[];
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={`opt ${value === o.id ? 'active' : ''}`}
          disabled={disabled}
          onClick={() => value !== o.id && onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function NichePicker({ value, disabled, onChange }: { value: string[]; disabled?: boolean; onChange: (next: string[]) => void }) {
  const [custom, setCustom] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const toggle = (n: string) => onChange(value.includes(n) ? value.filter((x) => x !== n) : [...value, n]);
  const add = () => {
    const v = custom.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (!v) return;
    // Same rule as onboarding: a niche is a topic to search trends for.
    if (v.split('-').length > 4 || /[.,]/.test(v)) {
      setHint('Keep it to a topic, like "voice ai".');
      return;
    }
    setHint(null);
    setCustom('');
    if (!value.includes(v)) onChange([...value, v]);
  };
  const all = [...Object.keys(NICHE_LABELS), ...value.filter((n) => !(n in NICHE_LABELS))];
  return (
    <div className="stack">
      <div className="ap-chips">
        {all.map((n) => (
          <button key={n} type="button" className="ap-chip" aria-pressed={value.includes(n)} disabled={disabled} onClick={() => toggle(n)}>
            {NICHE_LABELS[n] ?? n.replace(/-/g, ' ')}
          </button>
        ))}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="input" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Add your own, e.g. voice ai" disabled={disabled} aria-label="Add a topic" />
        <button className="btn" type="submit" disabled={disabled || !custom.trim()}>Add</button>
      </form>
      {hint && <p className="ap-hint ap-hint--err">{hint}</p>}
    </div>
  );
}

/** Text field that saves on blur when it changed. */
function SavedField({ label, value, multiline, placeholder, disabled, onSave }: {
  label: string;
  value: string;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const props = {
    className: 'input',
    value: v,
    placeholder,
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => v.trim() !== value.trim() && onSave(v.trim()),
  };
  return (
    <label className="ap-field">
      <span className="ap-label">{label}</span>
      {multiline ? <textarea rows={4} {...props} /> : <input {...props} />}
    </label>
  );
}

export default function PlanSettings() {
  const { data: settings, error: settingsError, mutate: refetchSettings, unauth } = useApi<Settings>('/api/agent/settings');
  const { data: accounts } = useApi<{ platform: Platform }[]>('/api/accounts');

  // After switching on, the server starts filling the plan in the background.
  // `watchFrom` is the planned count at that moment: poll fast until it moves
  // (or 90s pass) so the page shows the first posts arriving.
  const [watchFrom, setWatchFrom] = useState<number | null>(() => {
    // Arriving straight from onboarding's "Enter Sociafy", which just switched it on.
    const at = typeof window === 'undefined' ? 0 : Number(window.sessionStorage.getItem('sociafy:autopilotStartedAt'));
    return Date.now() - at < 90_000 ? 0 : null;
  });
  const { data: status, mutate: refetchStatus } = useApi<StatusPayload>('/api/agent/status', {
    refreshInterval: watchFrom !== null ? 4_000 : 60_000,
  });
  const starting = watchFrom !== null && (status?.planned ?? 0) === watchFrom;
  useEffect(() => {
    if (watchFrom === null) return;
    const t = setTimeout(() => setWatchFrom(null), starting ? 90_000 : 0);
    return () => clearTimeout(t);
  }, [watchFrom, starting]);

  // Local copies so controls respond instantly; the server stays the source of truth.
  const [enabled, setEnabled] = useState(false);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [total, setTotal] = useState(4);
  const [quiet, setQuiet] = useState({ start: '22:00', end: '07:00' });
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setPlatforms(settings.enabledPlatforms ?? []);
    const m = settings.postsPerWeekByContentType;
    setTotal(m ? m.text + m.image + m.video : 4);
    setQuiet(settings.quietHours ?? { start: '22:00', end: '07:00' });
  }, [settings]);

  /** Every settings write. Returns whether it landed. */
  const persist = async (patch: Partial<Settings> & { postsPerWeekByPlatform?: Partial<Record<Platform, number>> }): Promise<boolean> => {
    setSaveError(null);
    try {
      await apiPatch('/api/agent/settings', patch);
      const [, fresh] = await Promise.all([refetchSettings(), refetchStatus()]);
      // These kick a plan top-up server-side — show the posts arriving.
      const kicks = patch.enabled === true || 'niches' in patch || 'enabledPlatforms' in patch;
      if (kicks && fresh && 'dueNow' in fresh && fresh.enabled && fresh.dueNow) setWatchFrom(fresh.planned);
      return true;
    } catch (e) {
      setSaveError(friendlyApiError(e));
      return false;
    }
  };

  const niches = useMemo(() => settings?.niches ?? [], [settings]);
  const connected = useMemo(() => [...new Set((accounts ?? []).map((a) => a.platform))], [accounts]);
  const mix = settings?.postsPerWeekByContentType ?? { text: total, image: 0, video: 0 };
  const preset = presetOf(mix, platforms);
  const burn = estimateWeeklyBurn({ platforms, cadencePerWeek: total, postsPerWeekByContentType: mix });
  const needsSetup = !!settings && niches.length === 0;
  const locked = !!unauth || !settings;
  const horizon = settings?.planHorizonDays ?? 7;
  const auto = (settings?.autoPublishThreshold ?? 101) <= 100;

  /** Platforms, niches and the weekly number all feed the derived per-platform caps and the mix. */
  const savePlan = (next: { platforms?: Platform[]; niches?: string[]; total?: number; preset?: MixPreset }) => {
    const p = next.platforms ?? platforms;
    const n = next.niches ?? niches;
    const t = next.total ?? total;
    const pr = next.preset ?? preset ?? 'mixed';
    return persist({
      ...(next.platforms && { enabledPlatforms: p }),
      ...(next.niches && { niches: n as Niche[] }),
      postsPerWeekByContentType: mixFor(pr, t, p),
      postsPerWeekByPlatform: platformCaps(p, n, t),
    });
  };

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    // Snap back if the server didn't take it — "on" when it isn't is the worst lie here.
    if (!(await persist({ enabled: next }))) setEnabled(!next);
  };

  const togglePlatform = async (p: Platform) => {
    const prev = platforms;
    const next = prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p];
    setPlatforms(next);
    if (!(await savePlan({ platforms: next }))) setPlatforms(prev);
  };

  const blocked = enabled && status?.blocked ? BLOCKED[status.blocked] : null;
  const pending = status?.pendingReview.length ?? 0;

  let planLine: string;
  if (!enabled) planLine = 'Paused. Nothing is drafted or posted.';
  else if (starting) planLine = 'Writing your first posts now…';
  else if (!status) planLine = `Plans ${horizon} days ahead`;
  else if (status.nextTopUpAt) planLine = `Plans ${horizon} days ahead · next top-up ${when(status.nextTopUpAt)}`;
  else planLine = `Plans ${horizon} days ahead · ${status.planned} of ${status.target} posts ready`;

  return (
    <div className="ap">
      {settingsError && (
        <p className="ap-alert" role="alert">Couldn&apos;t load your plan. Don&apos;t change anything until it loads.</p>
      )}
      {saveError && (
        <p className="ap-alert" role="alert">
          That change wasn&apos;t saved. {saveError}
          <button className="btn sm ghost" onClick={() => setSaveError(null)}>Dismiss</button>
        </p>
      )}
      {unauth && (
        <p className="ap-alert"><Link href="/sign-in?next=/autopilot">Sign in</Link> to set up your plan.</p>
      )}

      <section className="ap-section" aria-labelledby="ap-status">
        <div className="ap-status">
          <div>
            <h2 id="ap-status" className="ap-title">
              <span className={`ap-dot ${enabled ? (blocked ? 'ap-dot--warn' : 'ap-dot--on') : ''}`} aria-hidden="true" />
              Autopilot is {enabled ? (blocked ? 'stuck' : 'on') : 'off'}
            </h2>
            <p className="ap-sub">{planLine}</p>
          </div>
          <button
            className={`btn ${enabled ? '' : 'primary'}`}
            onClick={toggleEnabled}
            disabled={locked || needsSetup}
            title={needsSetup ? 'Pick at least one topic first.' : undefined}
          >
            {enabled ? 'Pause' : 'Turn on'}
          </button>
        </div>
        {needsSetup && <p className="ap-hint">Pick at least one topic below to turn it on.</p>}
        {blocked && (
          <p className="ap-blocked" role="status">
            {blocked.text}{' '}
            {blocked.href && <Link href={blocked.href}>{blocked.cta}</Link>}
          </p>
        )}
        <div className="ap-row">
          <span className="ap-label">Before posting</span>
          <Choice
            label="Before posting"
            value={auto ? 'auto' : 'ask'}
            options={[{ id: 'ask', label: 'Ask me first' }, { id: 'auto', label: 'Post automatically' }]}
            disabled={locked}
            onChange={(v) => persist({ autoPublishThreshold: v === 'auto' ? AUTO_THRESHOLD : 101 })}
          />
        </div>
        {pending > 0 && (
          <p className="ap-sub">{pending} {pending === 1 ? 'post is' : 'posts are'} waiting for you. <Link href="/dashboard">Review</Link></p>
        )}
      </section>

      <section className="ap-section">
        <div className="ap-row">
          <h2 className="ap-title">How often do you visit?</h2>
          <Choice
            label="How often do you visit?"
            value={horizon === 30 ? 30 : 7}
            options={[{ id: 7, label: 'Weekly' }, { id: 30, label: 'Monthly' }]}
            disabled={locked}
            onChange={(d) => persist({ planHorizonDays: d })}
          />
        </div>
        <p className="ap-sub">We keep {horizon === 30 ? 'a month' : 'a week'} of posts ready for you to review in one sitting.</p>
      </section>

      <section className="ap-section" id="ap-topics" aria-labelledby="ap-topics-h">
        <h2 id="ap-topics-h" className="ap-title">Topics</h2>
        <NichePicker value={niches} disabled={locked} onChange={(next) => savePlan({ niches: next })} />
      </section>

      <section className="ap-section" aria-labelledby="ap-platforms-h">
        <div className="ap-row">
          <h2 id="ap-platforms-h" className="ap-title">Platforms</h2>
          <Link className="ap-link" href="/settings/connections">Manage connections</Link>
        </div>
        {accounts && connected.length === 0 ? (
          <p className="ap-sub">No accounts connected yet. <Link href="/settings/connections">Connect one</Link></p>
        ) : (
          <ul className="ap-list">
            {connected.map((p) => (
              <li key={p}>
                <label className="ap-toggle">
                  <span>{PLATFORM_NAMES[p]}</span>
                  <input type="checkbox" role="switch" checked={platforms.includes(p)} disabled={locked} onChange={() => togglePlatform(p)} />
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ap-section" aria-labelledby="ap-volume-h">
        <div className="ap-row">
          <h2 id="ap-volume-h" className="ap-title">Posts per week</h2>
          <input
            className="input ap-number"
            type="number"
            min={1}
            max={50}
            value={total}
            disabled={locked}
            aria-label="Posts per week"
            onChange={(e) => setTotal(Math.max(1, Math.min(50, parseInt(e.target.value || '1', 10))))}
            onBlur={() => settings && total !== mix.text + mix.image + mix.video && savePlan({ total })}
          />
        </div>
        <div className="ap-row">
          <Choice label="Post types" value={preset} options={PRESETS} disabled={locked} onChange={(pr) => savePlan({ preset: pr })} />
          <span className="ap-sub tnum">≈ {burn.weekly.toLocaleString()} credits per week</span>
        </div>
      </section>

      <details className="ap-section ap-advanced" id="ap-advanced">
        <summary className="ap-title">Advanced</summary>
        <div className="stack ap-advanced__body">
          <SavedField
            label="Instructions"
            multiline
            value={settings?.instructions ?? ''}
            placeholder="How should posts sound? What should they avoid?"
            disabled={locked}
            onSave={(v) => persist({ instructions: v })}
          />
          <SavedField label="Brand name" value={settings?.companyName ?? ''} disabled={locked} onSave={(v) => persist({ companyName: v })} />
          <SavedField label="What you do" multiline value={settings?.brandBio ?? ''} disabled={locked} onSave={(v) => persist({ brandBio: v })} />
          <SavedField label="Website" value={settings?.website ?? ''} placeholder="https://" disabled={locked} onSave={(v) => persist({ website: v && !/^https?:\/\//i.test(v) ? `https://${v}` : v })} />
          <div className="ap-field">
            <span className="ap-label">Quiet hours</span>
            <div className="row">
              {(['start', 'end'] as const).map((k, i) => (
                <React.Fragment key={k}>
                  {i === 1 && <span className="ap-sub">to</span>}
                  <input
                    className="input ap-time"
                    type="time"
                    aria-label={`Quiet hours ${k}`}
                    value={quiet[k]}
                    disabled={locked}
                    onChange={(e) => setQuiet((q) => ({ ...q, [k]: e.target.value }))}
                    onBlur={() => quiet.start && quiet.end && (quiet.start !== settings?.quietHours?.start || quiet.end !== settings?.quietHours?.end) && persist({ quietHours: quiet })}
                  />
                </React.Fragment>
              ))}
            </div>
          </div>
          <label className="ap-toggle">
            <span>
              Strict brand safety
              <span className="ap-hint">Holds anything that mentions competitors or makes unverified claims.</span>
            </span>
            <input type="checkbox" role="switch" checked={settings?.brandSafetyStrict ?? true} disabled={locked} onChange={(e) => persist({ brandSafetyStrict: e.target.checked })} />
          </label>
          <label className="ap-field">
            <span className="ap-label">Weekly credit cap</span>
            <input
              className="input ap-number"
              type="number"
              min={0}
              // Uncontrolled; the key resets it when the saved value changes.
              key={String(settings?.weeklyCreditCap)}
              defaultValue={settings?.weeklyCreditCap ?? ''}
              placeholder="No cap"
              disabled={locked}
              onBlur={(e) => {
                const v = e.target.value.trim();
                const cap = v === '' ? null : Math.max(0, parseInt(v, 10) || 0);
                if (cap !== (settings?.weeklyCreditCap ?? null)) persist({ weeklyCreditCap: cap });
              }}
            />
          </label>
        </div>
      </details>
    </div>
  );
}
