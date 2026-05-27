'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Icon } from './icons';
import { apiPatch, apiPost, useApi } from '../lib/ui/fetcher';
import type { Niche, Platform } from '../lib/db/schema';
import { estimateWeeklyBurn, weeksOfRunway } from '../lib/credits/estimator';
import type { CreditsPayload } from './credits';

type BriefMode = 'text' | 'image' | 'video';
type ConnectedAccount = { id: string; platform: Platform };

type AgentSettings = {
  enabled: boolean;
  instructions: string;
  cadencePerWeek: number;
  autoPublishThreshold: number;
  brandSafetyStrict: boolean;
  niches: Niche[];
  voiceTemplate: 'me' | 'punchy' | 'thoughtful' | 'data-led';
  quietHours: { start: string; end: string };
  lastRunAt: string | null;
  companyName: string | null;
  brandBio: string | null;
  website: string | null;
  enabledPlatforms: Array<'x' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'youtube'>;
  postsPerWeekByPlatform: Partial<Record<'x' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'youtube', number>>;
  postsPerWeekByContentType: { text: number; image: number; video: number };
};

type Activity = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

type Trend = {
  id: string;
  niche: string;
  title: string;
  summary: string | null;
  source: string | null;
  sourceUrl: string | null;
  score: number;
  status: 'new' | 'used' | 'dismissed';
  capturedAt: string;
};

const NICHE_LABELS: Record<Niche, string> = {
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

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const KIND_LABEL: Record<string, { label: string; tone: 'accent' | 'warn' | '' }> = {
  trend_spotted: { label: 'Trend', tone: 'accent' },
  agent_drafted: { label: 'Drafted', tone: '' },
  auto_publish: { label: 'Scheduled', tone: 'accent' },
  agent_held: { label: 'Held', tone: 'warn' },
  publish_failed: { label: 'Failed', tone: 'warn' },
  manual_publish: { label: 'Posted', tone: '' },
  platform_connected: { label: 'Connected', tone: '' },
  platform_disconnected: { label: 'Disconnected', tone: '' },
  draft_created: { label: 'Drafted', tone: '' },
  draft_scheduled: { label: 'Scheduled', tone: '' },
  agent_enabled: { label: 'Enabled', tone: '' },
  agent_disabled: { label: 'Paused', tone: '' },
  onboarded: { label: 'Onboarded', tone: '' },
};

const DEMO_FEED: Activity[] = [
  { id: 'demo-1', kind: 'trend_spotted', title: 'Spotted "agentic content" mentions', body: 'Adjacent niche signal up 312%. Drafting your angle.', meta: null, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() },
  { id: 'demo-2', kind: 'agent_drafted', title: 'Drafted 3 posts from your latest newsletter', body: 'Variant B scored highest against your style guide.', meta: null, createdAt: new Date(Date.now() - 14 * 60_000).toISOString() },
  { id: 'demo-3', kind: 'agent_held', title: 'Held a draft — tone mismatch', body: 'Used "game-changing" twice. Rewriting and re-queuing.', meta: null, createdAt: new Date(Date.now() - 60 * 60_000).toISOString() },
];

const HOW_IT_WORKS_STEPS = [
  {
    icon: 'fire' as const,
    title: '1. It watches your niches',
    body: 'Every few hours it pulls fresh trends from the niches you picked — RSS feeds, search trends, Reddit signals — and scores them against what you usually post about.',
  },
  {
    icon: 'sparkle' as const,
    title: '2. It drafts in your voice',
    body: 'When a trend scores high enough, it writes a post in your voice (set by your style guide + voice template) and adapts it per platform.',
  },
  {
    icon: 'check' as const,
    title: '3. It auto-schedules — or holds',
    body: 'Drafts scoring above your auto-publish threshold get scheduled into your calendar respecting quiet hours. Anything lower waits in Drafts for your review.',
  },
  {
    icon: 'bolt' as const,
    title: 'You stay in control',
    body: 'Pause any time. Tighten the cadence, raise the threshold, or edit a draft before it ships. Everything it does shows up in the activity feed below.',
  },
];

const HowItWorksCard: React.FC<{ expanded: boolean }> = ({ expanded: initialExpanded }) => {
  const [expanded, setExpanded] = useState(initialExpanded);
  return (
    <div className="card">
      <div
        className="card-head"
        style={{ cursor: 'pointer' }}
        onClick={() => setExpanded((v) => !v)}
      >
        <h3>
          <Icon name="bolt" size={14} /> How Autopilot works
        </h3>
        <span className="chip ghost mono">{expanded ? 'Hide' : 'Show'}</span>
      </div>
      {expanded && (
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
            {HOW_IT_WORKS_STEPS.map((s) => (
              <div key={s.title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, background: 'var(--bg-sunk)', borderRadius: 10 }}>
                <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--bg-elev)', color: 'var(--accent)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                  <Icon name={s.icon} size={13} />
                </div>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{s.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>{s.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

interface AgentPageProps {
  onEditDraft?: (id: string) => void;
}

const AgentPage: React.FC<AgentPageProps> = ({ onEditDraft }) => {
  const { data: settings, mutate: refetchSettings, unauth } = useApi<AgentSettings>('/api/agent/settings');
  const { data: activity, mutate: refetchActivity } = useApi<Activity[]>('/api/activity?limit=30');
  const { data: trendsNew, mutate: refetchTrends } = useApi<Trend[]>('/api/trends?status=new&limit=20');
  const { data: trendsUsed } = useApi<Trend[]>('/api/trends?status=used&limit=10');

  const [autopilot, setAutopilot] = useState(false);
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [cadence, setCadence] = useState(4);
  const [threshold, setThreshold] = useState(90);
  const [strict, setStrict] = useState(true);
  const [savingInstr, setSavingInstr] = useState(false);
  /** Brand profile state — these get injected into every AI surface
   *  (image gen rewriter, video gen rewriter, caption variants) so output
   *  feels on-brand instead of generic. */
  const [companyName, setCompanyName] = useState('');
  const [brandBio, setBrandBio] = useState('');
  const [website, setWebsite] = useState('');
  const [savingBrand, setSavingBrand] = useState(false);
  const [brandEditing, setBrandEditing] = useState(false);

  /** Autopilot permission matrix — controls which platforms the agent
   *  may post to, how often per platform, and the text/image/video mix.
   *  All edits flush to the server via `saveRules`. */
  const [enabledPlatforms, setEnabledPlatforms] = useState<Array<'x' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'youtube'>>([]);
  const [postsPerPlatform, setPostsPerPlatform] = useState<Partial<Record<'x' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'youtube', number>>>({});
  const [contentTypeMix, setContentTypeMix] = useState<{ text: number; image: number; video: number }>({ text: 4, image: 0, video: 0 });
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('07:00');
  const [savingRules, setSavingRules] = useState(false);
  /** Briefly flashes a "Saved" pill on auto-save. Cleared after 1.5s so
   *  successive edits don't pile up timeouts. */
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 1500);
    return () => clearTimeout(t);
  }, [savedAt]);
  const [running, setRunning] = useState<'agent' | 'trends' | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  // Ask-first modal: replaces the silent "Run agent" flow with an explicit
  // brief from the user. The agent's auto-cadence still runs in the background;
  // this is the manual button.
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefTopic, setBriefTopic] = useState('');
  const [briefAngle, setBriefAngle] = useState('');
  const [briefMode, setBriefMode] = useState<BriefMode>('text');
  const [briefScheduleNow, setBriefScheduleNow] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefMsg, setBriefMsg] = useState<string | null>(null);
  const { data: accountsForBrief } = useApi<ConnectedAccount[]>('/api/accounts');

  const openBrief = () => {
    setBriefTopic('');
    setBriefAngle('');
    setBriefMode('text');
    setBriefScheduleNow(false);
    setBriefMsg(null);
    setBriefOpen(true);
  };

  const submitBrief = async () => {
    if (!briefTopic.trim()) {
      setBriefMsg('Tell the agent what to write about first.');
      return;
    }
    setBriefBusy(true);
    setBriefMsg('Drafting…');
    try {
      const platforms = (accountsForBrief ?? []).map((a) => a.platform).slice(0, 4);
      if (platforms.length === 0) {
        setBriefMsg('Connect at least one platform first.');
        return;
      }
      // Compose with the user's brief — topic + optional angle become one prompt.
      const promptText = briefAngle.trim()
        ? `${briefTopic.trim()}\n\nAngle: ${briefAngle.trim()}`
        : briefTopic.trim();
      const composed = await apiPost<{
        variants: { label: string; text: string; score?: number; rationale?: string }[];
        perPlatform: Partial<Record<Platform, string>>;
      }>('/api/compose/variants', {
        prompt: promptText,
        platforms,
        preset: briefMode === 'video' ? 'reel' : 'announcement',
      });
      const best = composed.variants?.[0];
      if (!best) {
        setBriefMsg('No draft came back. Try a different brief.');
        return;
      }
      const draft = await apiPost<{ id: string }>('/api/drafts', {
        prompt: promptText,
        body: best.text,
        variants: composed.variants.map((v) => ({ label: v.label, text: v.text, score: v.score, rationale: v.rationale })),
        selectedVariantLabel: best.label,
        targetPlatforms: platforms,
        perPlatformText: composed.perPlatform ?? {},
        preset: briefMode === 'video' ? 'reel' : 'announcement',
      });
      if (briefScheduleNow) {
        const when = new Date(Date.now() + 30 * 60 * 1000); // +30 min, sane default
        await apiPost('/api/schedule', { draftId: draft.id, scheduledAt: when.toISOString(), platforms });
        setBriefMsg(`Drafted + scheduled for ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`);
      } else {
        setBriefMsg('Drafted. Open the Compose page to review or schedule it.');
      }
      await refetchActivity();
      setTimeout(() => { setBriefOpen(false); setBriefMsg(null); }, 900);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBriefMsg(`Failed: ${msg.slice(0, 140)}`);
    } finally {
      setBriefBusy(false);
    }
  };

  const runAgentNow = async () => {
    setRunning('agent');
    setRunMsg(null);
    try {
      const r = await apiPost<{ drafted: number; published: number; held: number; reason?: string }>(
        '/api/agent/run',
        {},
      );
      if (r.reason) {
        setRunMsg(`Skipped: ${r.reason.replace(/_/g, ' ')}`);
      } else {
        setRunMsg(`Drafted ${r.drafted} · scheduled ${r.published} · held ${r.held}`);
      }
      await refetchActivity();
      await refetchSettings();
      await refetchTrends();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRunMsg(`Failed: ${msg}`);
    } finally {
      setRunning(null);
    }
  };

  const refreshTrends = async () => {
    setRunning('trends');
    setRunMsg(null);
    try {
      const r = await apiPost<{ inserted: number; reason?: string }>('/api/trends/refresh', {});
      if (r.reason) setRunMsg(`Skipped: ${r.reason.replace(/_/g, ' ')}`);
      else setRunMsg(`Pulled ${r.inserted} trends from your niches`);
      await refetchTrends();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRunMsg(`Failed: ${msg}`);
    } finally {
      setRunning(null);
    }
  };


  useEffect(() => {
    if (!settings) return;
    setAutopilot(settings.enabled);
    setInstructions(settings.instructions);
    setCadence(settings.cadencePerWeek);
    setThreshold(settings.autoPublishThreshold);
    setStrict(settings.brandSafetyStrict);
    setCompanyName(settings.companyName ?? '');
    setBrandBio(settings.brandBio ?? '');
    setWebsite(settings.website ?? '');
    setEnabledPlatforms(settings.enabledPlatforms ?? []);
    setPostsPerPlatform(settings.postsPerWeekByPlatform ?? {});
    setContentTypeMix(settings.postsPerWeekByContentType ?? { text: 4, image: 0, video: 0 });
    setQuietStart(settings.quietHours?.start ?? '22:00');
    setQuietEnd(settings.quietHours?.end ?? '07:00');
  }, [settings]);

  /** Save autopilot rules — fires on every change of platform toggle or
   *  number step. Server is the source of truth for run.ts. */
  const saveRules = async (patch: {
    enabledPlatforms?: typeof enabledPlatforms;
    postsPerWeekByPlatform?: typeof postsPerPlatform;
    postsPerWeekByContentType?: typeof contentTypeMix;
  }) => {
    setSavingRules(true);
    try {
      await apiPatch('/api/agent/settings', patch);
      await refetchSettings();
      setSavedAt(Date.now());
    } finally {
      setSavingRules(false);
    }
  };

  const saveBrand = async () => {
    setSavingBrand(true);
    try {
      await apiPatch('/api/agent/settings', {
        companyName: companyName.trim() || undefined,
        brandBio: brandBio.trim() || undefined,
        website: website.trim() || undefined,
      });
      await refetchSettings();
      setBrandEditing(false);
    } finally {
      setSavingBrand(false);
    }
  };

  const saveAutopilot = async (next: boolean) => {
    setAutopilot(next);
    try {
      await apiPatch('/api/agent/settings', { enabled: next });
      await refetchSettings();
    } catch {
      setAutopilot(!next);
    }
  };

  const saveInstructions = async () => {
    setSavingInstr(true);
    try {
      await apiPatch('/api/agent/settings', { instructions });
      await refetchSettings();
      setEditing(false);
    } finally {
      setSavingInstr(false);
    }
  };

  const updateField = async (patch: Partial<AgentSettings>) => {
    try {
      await apiPatch('/api/agent/settings', patch);
      await refetchSettings();
    } catch {/* ignore */}
  };

  const niches = settings?.niches ?? [];
  // Demo feed only for unauthenticated visitors. Signed-in users with an
  // empty activity log see the real empty state below, not fake events.
  const feed = unauth ? DEMO_FEED : (activity ?? []);

  // First-run state: signed in but no niches picked yet. We block the
  // Resume button until they've at least named what to write about so
  // Autopilot doesn't run "blind".
  const needsSetup = !unauth && niches.length === 0;

  // Credit balance + live weekly burn estimate for the budget card.
  // Recomputes whenever the user tweaks the autopilot rules.
  const { data: creditsData } = useApi<CreditsPayload>('/api/credits', { refreshInterval: 60_000 });
  const burnEstimate = useMemo(() => estimateWeeklyBurn({
    platforms: enabledPlatforms as Platform[],
    cadencePerWeek: cadence,
    postsPerWeekByContentType: contentTypeMix,
    withResearch: false,
  }), [enabledPlatforms, cadence, contentTypeMix]);
  const balance = creditsData?.balance ?? 0;
  const runway = creditsData ? weeksOfRunway(burnEstimate.weekly, balance) : -1;

  // First-run tooltip on the activity feed. Shows once, the first time the
  // user enables autopilot — lives in localStorage so it doesn't nag again.
  const [showFirstRunTip, setShowFirstRunTip] = useState(false);
  useEffect(() => {
    if (autopilot && typeof window !== 'undefined') {
      const seen = window.localStorage.getItem('sociafy:firstAutopilotEnabled');
      if (!seen) setShowFirstRunTip(true);
    }
  }, [autopilot]);
  const dismissFirstRunTip = () => {
    setShowFirstRunTip(false);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('sociafy:firstAutopilotEnabled', String(Date.now()));
    }
  };
  // Drafts-only when threshold > 100 (101 = our "never auto-publish" sentinel).
  const draftsOnly = threshold > 100;

  return (
    <div className="two-col">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* How Autopilot works — collapsible explainer card. Always visible on
            first run; signed-in users with niches already picked see it as a
            compact summary that can be expanded for a refresher. */}
        <HowItWorksCard expanded={needsSetup || !!unauth} />

        {needsSetup && (
          <div className="card" style={{ background: 'var(--accent-soft)', borderColor: 'oklch(0.86 0.08 70)' }}>
            <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--accent)', color: 'white', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <Icon name="sparkle" size={16} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: 'var(--accent-ink)' }}>One more step before Autopilot can run</div>
                <div style={{ fontSize: 12.5, color: 'var(--accent-ink)', marginBottom: 10 }}>
                  Pick the niches you want it to track, set how often it should draft, and tell it your voice. Without these it has nothing to write about.
                </div>
                <a
                  href="/onboarding"
                  className="btn primary"
                  style={{ textDecoration: 'none', display: 'inline-flex' }}
                >
                  <Icon name="bolt" size={12} /> Finish setup
                </a>
              </div>
            </div>
          </div>
        )}

        <div className="card" style={{ background: autopilot ? 'var(--bg-elev)' : 'var(--bg-sunk)', opacity: needsSetup ? 0.5 : 1 }}>
          <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 16, alignItems: 'center' }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: autopilot ? 'var(--ink)' : 'var(--bg-sunk)', color: autopilot ? 'var(--accent)' : 'var(--ink-3)', display: 'grid', placeItems: 'center', position: 'relative' }}>
              <Icon name="bolt" size={18} />
              {autopilot && <span style={{ position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: '50%', background: 'var(--good)', border: '2px solid var(--bg-elev)' }} />}
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 550, letterSpacing: '-0.01em', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
                Autopilot is {autopilot ? 'running' : 'paused'}
                {settings?.lastRunAt && (
                  <span className="chip ghost mono" style={{ fontSize: 10 }}>
                    Last drafted {relTime(settings.lastRunAt)}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                {autopilot
                  ? `Monitoring ${niches.length} niches, drafting on a ${cadence}/week cadence, ${draftsOnly ? 'sending every draft to your inbox for review' : `auto-publishing posts scoring ≥ ${threshold}`}.`
                  : "I'll keep watching but won't draft or post without you."}
              </div>
            </div>
            <button
              className={`btn ${autopilot ? '' : 'primary'}`}
              onClick={() => saveAutopilot(!autopilot)}
              disabled={unauth || needsSetup}
              title={needsSetup ? 'Finish setup first — pick at least one niche.' : undefined}
            >
              {autopilot ? <><Icon name="pause" size={12} /> Pause</> : <><Icon name="play" size={12} /> Resume</>}
            </button>
          </div>
          {autopilot && enabledPlatforms.length === 0 && (
            <div style={{ padding: '8px 14px', fontSize: 12, color: 'oklch(0.45 0.18 30)', background: 'oklch(0.97 0.04 30)', borderTop: '1px solid oklch(0.86 0.08 30)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="bolt" size={11} />
              No platforms enabled in Autopilot rules — Autopilot has nowhere to post. Toggle at least one platform on the right.
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h3><Icon name="bolt" size={14} /> Tell the agent what to do</h3>
            {(runMsg || briefMsg) && <span className="chip ghost mono">{runMsg ?? briefMsg}</span>}
          </div>
          <div className="card-body" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <button
              className="btn accent"
              onClick={openBrief}
              disabled={unauth || needsSetup}
              title={needsSetup ? 'Finish setup first.' : 'Brief the agent before it drafts.'}
            >
              <Icon name="sparkle" size={12} /> Brief the agent
            </button>
            <button className="btn" onClick={refreshTrends} disabled={running !== null || unauth || needsSetup}>
              <Icon name="refresh" size={12} /> {running === 'trends' ? 'Refreshing…' : 'Pull fresh trends'}
            </button>
            <button
              className="btn ghost"
              onClick={runAgentNow}
              disabled={running !== null || unauth || needsSetup}
              title="Lets the agent pick from your fresh trends instead of giving it a topic."
            >
              <Icon name="bolt" size={12} /> {running === 'agent' ? 'Drafting…' : 'Auto-draft from trends'}
            </button>
            <div style={{ flex: 1, minWidth: 12 }} />
            <span style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 6, maxWidth: 280 }}>
              <Icon name="bolt" size={11} style={{ flexShrink: 0 }} />
              Briefing gives the agent a topic + angle in your voice. Auto-draft lets it pick from your trends.
            </span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="fire" size={14} />
              Trends ready to draft
              <span className="chip ghost mono">{trendsNew?.length ?? 0} new</span>
              {trendsUsed && trendsUsed.length > 0 && <span className="chip ghost mono">{trendsUsed.length} used</span>}
            </h3>
            <span className="meta">Sorted by score</span>
          </div>
          <div className="card-body" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!trendsNew || trendsNew.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--ink-3)', padding: 10 }}>
                No fresh trends yet. Click <strong>Pull fresh trends</strong> above to ingest from your niches.
              </div>
            ) : (
              trendsNew.map((t) => {
                const Tag: keyof React.JSX.IntrinsicElements = t.sourceUrl ? 'a' : 'div';
                return (
                  <Tag
                    key={t.id}
                    {...(t.sourceUrl ? { href: t.sourceUrl, target: '_blank', rel: 'noreferrer' } : {})}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 14,
                      padding: 14,
                      background: 'var(--bg-sunk)',
                      border: '1px solid var(--line)',
                      borderRadius: 10,
                      textDecoration: 'none',
                      color: 'inherit',
                      cursor: t.sourceUrl ? 'pointer' : 'default',
                      transition: 'background 120ms ease, border-color 120ms ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!t.sourceUrl) return;
                      (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)';
                      (e.currentTarget as HTMLElement).style.background = 'var(--bg-elev)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.borderColor = 'var(--line)';
                      (e.currentTarget as HTMLElement).style.background = 'var(--bg-sunk)';
                    }}
                  >
                    <div style={{ minWidth: 44, fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 600, color: 'var(--accent)', flexShrink: 0, textAlign: 'left' }}>
                      {t.score}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.4, color: 'var(--ink)' }}>
                        {t.title}
                      </div>
                      {t.summary && (
                        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 5, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {t.summary}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} className="mono">
                        <span className="chip">{t.niche}</span>
                        {t.source && <span>{t.source}</span>}
                        <span>· {relTime(t.capturedAt)}</span>
                      </div>
                    </div>
                    {t.sourceUrl && (
                      <Icon name="arrow_right" size={14} style={{ color: 'var(--ink-3)', flexShrink: 0, marginTop: 4 }} />
                    )}
                  </Tag>
                );
              })
            )}
          </div>
        </div>

        {unauth && (
          <div style={{ padding: 12, background: 'rgba(124,77,255,0.06)', border: '1px solid rgba(124,77,255,0.2)', borderRadius: 10, fontSize: 13 }}>
            Demo mode. <a href="/sign-in?next=/dashboard" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>Sign in</a> to configure a real autopilot.
          </div>
        )}

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
            {showFirstRunTip && (
              <div style={{
                padding: 12,
                background: 'var(--accent-soft)',
                border: '1px solid oklch(0.86 0.08 70)',
                borderRadius: 8,
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}>
                <Icon name="sparkle" size={14} style={{ color: 'var(--accent-ink)', marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1, fontSize: 12.5, color: 'var(--accent-ink)', lineHeight: 1.5 }}>
                  <strong>Autopilot is on.</strong> Your agent will draft over the next hour. Drafts land here {draftsOnly ? '— review and approve each one before it goes live.' : `— anything scoring ≥ ${threshold} auto-publishes; the rest waits for your review.`}
                </div>
                <button className="btn sm ghost" onClick={dismissFirstRunTip} aria-label="Dismiss">✕</button>
              </div>
            )}
            {feed.map((a) => {
              const meta = KIND_LABEL[a.kind] ?? { label: a.kind, tone: '' as const };
              return (
                <div className="agent-card" key={a.id}>
                  <div className="agent-mark">A</div>
                  <div>
                    <div className="agent-meta">
                      <span>Agent</span>
                      <span style={{ color: 'var(--ink-4)' }}>·</span>
                      <span>{relTime(a.createdAt)}</span>
                      <span className={`chip ${meta.tone}`}><span className="dot" />{meta.label}</span>
                    </div>
                    <div className="agent-title">{a.title}</div>
                    {a.body && <div className="agent-body">{a.body}</div>}
                  </div>
                </div>
              );
            })}
            {feed.length === 0 && (
              <div style={{ padding: 14, fontSize: 13, color: 'var(--ink-3)' }}>No activity yet. Enable autopilot to start drafting.</div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="chat" size={14} />
              Agent instructions
              <span className="chip accent"><span className="dot" />Steers every draft</span>
            </h3>
            <button className="btn sm" onClick={() => editing ? saveInstructions() : setEditing(true)} disabled={savingInstr || unauth}>
              <Icon name={editing ? 'check' : 'edit'} size={11} /> {editing ? (savingInstr ? 'Saving…' : 'Save') : 'Edit'}
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
                {instructions || 'No instructions yet. Click Edit to write a style guide for the agent.'}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 11.5, color: 'var(--ink-3)' }}>
              <span className="mono">{instructions.length} chars</span>
              {settings?.lastRunAt && (
                <span className="mono">Last run: {relTime(settings.lastRunAt)}</span>
              )}
            </div>
          </div>
        </div>

        {/* Brand profile — feeds every AI surface. Moved to bottom of left
            column since it's set-once context that shapes the AI prompts
            but isn't a daily lever the user adjusts. */}
        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="sparkle" size={14} />
              Brand profile
              <span className="chip accent"><span className="dot" />Feeds every AI prompt</span>
            </h3>
            <button className="btn sm" onClick={() => brandEditing ? saveBrand() : setBrandEditing(true)} disabled={savingBrand || unauth}>
              <Icon name={brandEditing ? 'check' : 'edit'} size={11} /> {brandEditing ? (savingBrand ? 'Saving…' : 'Save') : 'Edit'}
            </button>
          </div>
          <div className="card-body">
            {brandEditing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Company / brand name</div>
                  <input
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Sociafy"
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--line-2)', borderRadius: 8, background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'inherit', outline: 'none' }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>What you do (bio)</div>
                  <textarea
                    value={brandBio}
                    onChange={(e) => setBrandBio(e.target.value)}
                    placeholder="AI-powered social media management for solo founders. We turn one prompt into on-brand posts, images, and Shorts across every platform."
                    style={{ width: '100%', minHeight: 90, padding: 10, fontSize: 13, border: '1px solid var(--line-2)', borderRadius: 8, background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5 }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Website</div>
                  <input
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://sociafy.app"
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--line-2)', borderRadius: 8, background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'var(--mono)', outline: 'none' }}
                  />
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                  These three fields get injected into the system prompt of every image rewrite, video rewrite, and caption variant generation. The richer they are, the more on-brand your output.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(companyName || brandBio || website) ? (
                  <>
                    {companyName && (
                      <div style={{ fontSize: 13, fontWeight: 550 }}>{companyName}</div>
                    )}
                    {brandBio && (
                      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)' }}>
                        {brandBio}
                      </div>
                    )}
                    {website && (
                      <div style={{ fontSize: 11.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)' }}>
                        <Icon name="link" size={10} /> {website}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--ink-3)', padding: 12, background: 'var(--bg-sunk)', borderRadius: 8, borderLeft: '2px solid var(--accent)' }}>
                    Add your brand name, what you do, and your website. Sociafy uses this as context for every image, video, and caption it generates.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Autopilot rules — moved from bottom of left column. This is the
            "permissions + quotas" panel: which platforms autopilot is
            allowed to post on, how often, and the text/image/video mix. */}
        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="lock" size={14} />
              Autopilot rules
              <span className="chip accent"><span className="dot" />Permissions</span>
            </h3>
            <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {savingRules ? (
                'Saving…'
              ) : savedAt ? (
                <span style={{ color: 'var(--good, #2a8a3b)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="check" size={10} /> Saved
                </span>
              ) : (
                'Auto-saves'
              )}
            </span>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Per-platform caps
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {(['x', 'linkedin', 'instagram', 'facebook', 'tiktok', 'youtube'] as const).map((p) => {
                  const on = enabledPlatforms.includes(p);
                  const cap = postsPerPlatform[p] ?? 0;
                  return (
                    <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: on ? 'var(--accent-soft)' : 'var(--bg-sunk)', border: `1px solid ${on ? 'var(--accent)' : 'var(--line-2)'}`, borderRadius: 8 }}>
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 500 }}>
                        {p === 'x' ? 'X' : p === 'linkedin' ? 'LinkedIn' : p === 'youtube' ? 'YouTube' : p === 'tiktok' ? 'TikTok' : p === 'instagram' ? 'Instagram' : 'Facebook'}
                      </span>
                      <button
                        className={`chip ${on ? 'accent' : 'ghost'}`}
                        onClick={() => {
                          const next = on ? enabledPlatforms.filter((x) => x !== p) : [...enabledPlatforms, p];
                          setEnabledPlatforms(next);
                          saveRules({ enabledPlatforms: next });
                        }}
                        disabled={unauth}
                        style={{ fontSize: 10 }}
                      >
                        {on ? 'on' : 'off'}
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={50}
                        value={cap}
                        disabled={!on || unauth}
                        onChange={(e) => {
                          const n = Math.max(0, Math.min(50, parseInt(e.target.value || '0', 10)));
                          setPostsPerPlatform((cur) => ({ ...cur, [p]: n }));
                        }}
                        onBlur={() => saveRules({ postsPerWeekByPlatform: postsPerPlatform })}
                        title="Posts per week"
                        style={{ width: 48, padding: '3px 6px', textAlign: 'center', border: '1px solid var(--line-2)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 11.5, opacity: on ? 1 : 0.4 }}
                      />
                      <span style={{ fontSize: 9.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>/wk</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Content mix per week
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {([
                  { id: 'text' as const,  icon: 'edit' as const,  label: 'Text' },
                  { id: 'image' as const, icon: 'image' as const, label: 'Image' },
                  { id: 'video' as const, icon: 'play' as const,  label: 'Video' },
                ]).map((t) => (
                  <div key={t.id} style={{ padding: 8, border: '1px solid var(--line-2)', borderRadius: 8, background: 'var(--bg-sunk)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                      <Icon name={t.icon} size={10} style={{ color: 'var(--accent)' }} />
                      <span style={{ fontSize: 11, fontWeight: 550 }}>{t.label}</span>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={50}
                      value={contentTypeMix[t.id]}
                      disabled={unauth}
                      onChange={(e) => {
                        const n = Math.max(0, Math.min(50, parseInt(e.target.value || '0', 10)));
                        setContentTypeMix((cur) => ({ ...cur, [t.id]: n }));
                      }}
                      onBlur={() => saveRules({ postsPerWeekByContentType: contentTypeMix })}
                      style={{ width: '100%', padding: '5px 8px', textAlign: 'center', border: '1px solid var(--line-2)', borderRadius: 5, background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 13 }}
                    />
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 6, fontFamily: 'var(--mono)' }}>
                Total: {contentTypeMix.text + contentTypeMix.image + contentTypeMix.video} / week
              </div>
            </div>
          </div>
        </div>

        {/* Credit Budget — derived from the rules above + the live balance.
            Shows weekly burn estimate + runway weeks so the user can see
            "this plan fits 4 weeks of my balance" at a glance. */}
        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="bolt" size={14} />
              Credit budget
            </h3>
            <Link href="/usage" className="meta" style={{ textDecoration: 'underline' }}>Usage →</Link>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <div className="mono" style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1 }}>
                  {burnEstimate.weekly.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>credits / week planned</div>
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', textAlign: 'right', lineHeight: 1.5 }}>
                <div>Balance {balance.toLocaleString()}</div>
                {runway > 0 ? <div>~{runway} weeks runway</div> : burnEstimate.weekly === 0 ? <div>no spend</div> : <div className="danger" style={{ color: '#b03333' }}>top up</div>}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {([
                { id: 'text' as const,  label: 'Text',  v: burnEstimate.byKind.text  },
                { id: 'image' as const, label: 'Image', v: burnEstimate.byKind.image },
                { id: 'video' as const, label: 'Video', v: burnEstimate.byKind.video },
              ]).map((r) => {
                const pct = burnEstimate.weekly > 0 ? Math.min(100, Math.round((r.v / burnEstimate.weekly) * 100)) : 0;
                return (
                  <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 50px', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{r.label}</span>
                    <span style={{ height: 5, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
                      <span style={{
                        display: 'block', height: '100%',
                        width: `${pct}%`,
                        background: r.id === 'text' ? 'oklch(0.76 0.13 200)' : r.id === 'image' ? 'oklch(0.72 0.18 55)' : 'oklch(0.55 0.21 30)',
                        transition: 'width 0.25s ease',
                      }} />
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink)', textAlign: 'right' }}>{r.v}</span>
                  </div>
                );
              })}
            </div>
            <Link href="/billing" className="btn ghost" style={{ justifyContent: 'center', fontSize: 11.5 }}>
              <Icon name="bolt" size={11} /> Top up or upgrade plan
            </Link>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3><Icon name="settings" size={14} /> Guardrails</h3>
          </div>
          <div className="card-body flush">
            {/* Cadence + publishing behavior + safety. The "Auto-publish"
                row now includes 101 ("Drafts only") as the default option
                — picking it routes every draft to your inbox for review. */}
            {[
              { label: 'Post cadence', hint: 'How many drafts per week.', key: 'cadence' as const, options: [2, 3, 4, 5, 7] },
              { label: 'Auto-publish', hint: 'Score threshold each draft must beat to ship automatically. Drafts only sends everything to your inbox for review.', key: 'threshold' as const, options: [101, 80, 85, 90, 95] },
              { label: 'Brand-safe filter', hint: 'Strict refuses anything mentioning competitors or unverified claims.', key: 'strict' as const, options: [true, false] },
            ].map((row) => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                <div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{row.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>{row.hint}</div>
                </div>
                <select
                  value={String(row.key === 'cadence' ? cadence : row.key === 'threshold' ? threshold : strict)}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (row.key === 'cadence') { setCadence(parseInt(v)); updateField({ cadencePerWeek: parseInt(v) }); setSavedAt(Date.now()); }
                    else if (row.key === 'threshold') { setThreshold(parseInt(v)); updateField({ autoPublishThreshold: parseInt(v) }); setSavedAt(Date.now()); }
                    else { const b = v === 'true'; setStrict(b); updateField({ brandSafetyStrict: b }); setSavedAt(Date.now()); }
                  }}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink)', background: 'transparent', border: 'none', textAlign: 'right' }}
                  disabled={unauth}
                >
                  {row.options.map((o) => (
                    <option key={String(o)} value={String(o)}>
                      {row.key === 'cadence' ? `${o} / week` :
                        row.key === 'threshold' ? (o === 101 ? 'Drafts only (review each)' : `Auto if score ≥ ${o}`) :
                        (o ? 'Strict' : 'Standard')}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' }}>
              <div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>Quiet hours</div>
                <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>Autopilot won&apos;t publish in this window.</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="time"
                  value={quietStart}
                  onChange={(e) => setQuietStart(e.target.value)}
                  onBlur={() => {
                    if (quietStart && quietEnd && (quietStart !== settings?.quietHours?.start || quietEnd !== settings?.quietHours?.end)) {
                      updateField({ quietHours: { start: quietStart, end: quietEnd } });
                      setSavedAt(Date.now());
                    }
                  }}
                  disabled={unauth}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11.5, padding: '4px 6px', border: '1px solid var(--line-2)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)' }}
                />
                <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>–</span>
                <input
                  type="time"
                  value={quietEnd}
                  onChange={(e) => setQuietEnd(e.target.value)}
                  onBlur={() => {
                    if (quietStart && quietEnd && (quietStart !== settings?.quietHours?.start || quietEnd !== settings?.quietHours?.end)) {
                      updateField({ quietHours: { start: quietStart, end: quietEnd } });
                      setSavedAt(Date.now());
                    }
                  }}
                  disabled={unauth}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11.5, padding: '4px 6px', border: '1px solid var(--line-2)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)' }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3><Icon name="globe" size={14} /> Niches I&apos;m watching</h3>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {niches.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                No niches selected yet. Set them in <a href="/onboarding" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>onboarding</a>.
              </div>
            )}
            {niches.map((n) => {
              const label = NICHE_LABELS[n as keyof typeof NICHE_LABELS] ?? n.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
              const isCustom = !NICHE_LABELS[n as keyof typeof NICHE_LABELS];
              return (
                <div key={n} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: 'var(--bg-sunk)' }}>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{label}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{isCustom ? 'custom niche' : 'RSS + community signals'}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Brief-the-agent modal */}
      {briefOpen && (
        <div
          className="modal-scrim"
          onClick={() => { if (!briefBusy) { setBriefOpen(false); setBriefMsg(null); } }}
        >
          <div
            className="modal-sheet"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(600px, 92vw)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <Icon name="sparkle" size={16} style={{ color: 'var(--accent)' }} />
              <h3 style={{ margin: 0, fontSize: 16, letterSpacing: '-0.01em' }}>
                What should I write?
              </h3>
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => { if (!briefBusy) { setBriefOpen(false); setBriefMsg(null); } }}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 16 }}>
              Give me a topic and an optional angle. I&apos;ll draft it in your voice and adapt it for each connected platform.
            </div>

            <label style={{ display: 'block', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Topic</label>
            <textarea
              value={briefTopic}
              onChange={(e) => setBriefTopic(e.target.value)}
              placeholder="e.g. We shipped a new onboarding flow and conversion went from 12% to 28%."
              autoFocus
              style={{
                width: '100%', minHeight: 76, padding: 12, fontSize: 13,
                border: '1px solid var(--line-2)', borderRadius: 10, background: 'var(--bg)',
                color: 'var(--ink)', fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5,
                marginBottom: 14,
              }}
            />

            <label style={{ display: 'block', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Angle (optional)</label>
            <input
              type="text"
              value={briefAngle}
              onChange={(e) => setBriefAngle(e.target.value)}
              placeholder="e.g. Lessons learned. Or: how it broke before it worked."
              style={{
                width: '100%', padding: '10px 12px', fontSize: 13,
                border: '1px solid var(--line-2)', borderRadius: 10, background: 'var(--bg)',
                color: 'var(--ink)', fontFamily: 'inherit', outline: 'none',
                marginBottom: 14,
              }}
            />

            <label style={{ display: 'block', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Post type</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              {(['text', 'image', 'video'] as BriefMode[]).map((m) => (
                <span
                  key={m}
                  onClick={() => setBriefMode(m)}
                  className={`prompt-chip ${briefMode === m ? 'active' : ''}`}
                  style={{ textTransform: 'capitalize' }}
                >
                  <Icon name={m === 'text' ? 'edit' : m === 'image' ? 'image' : 'play'} size={11} />
                  {m === 'text' ? 'Text' : m === 'image' ? 'Image' : 'Video'} post
                </span>
              ))}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ink-2)', cursor: 'pointer', marginBottom: 18 }}>
              <input type="checkbox" checked={briefScheduleNow} onChange={(e) => setBriefScheduleNow(e.target.checked)} />
              Schedule it in 30 minutes (otherwise it just lands in Drafts).
            </label>

            {briefMsg && (
              <div style={{ padding: 10, fontSize: 12.5, background: 'var(--bg-sunk)', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 14 }}>
                {briefMsg}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
              <button
                className="btn"
                onClick={() => { if (!briefBusy) { setBriefOpen(false); setBriefMsg(null); } }}
                disabled={briefBusy}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={submitBrief}
                disabled={briefBusy || !briefTopic.trim()}
              >
                {briefBusy
                  ? <><Icon name="refresh" size={12} /> Drafting</>
                  : <><Icon name="sparkle" size={12} /> Brief the agent</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentPage;
