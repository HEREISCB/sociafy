'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Icon, Pglyph } from './icons';
import { apiPatch, apiPost, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { healthFor } from '../lib/ui/health';
import { PLATFORMS } from '../lib/ui/platforms';
import { supportsKind } from '../lib/platforms/capabilities';
import { estimateWeeklyBurn, draftCost } from '../lib/credits/estimator';
import { mixFor, platformCaps, recommendPlan, type MixPreset } from '../lib/agent/recommend';
import { projectWeek } from '../lib/agent/week';
import type { Platform } from '../lib/db/schema';
import ConnectionsList, { isHealthy, useNow, useOAuthReturn, type Account } from './connections-list';
import { Stepper, TopicPicker } from './autopilot/controls';
import { Button, PinBar, Seg } from './ui';
import WeekStrip, { weekRange, type StripSlot } from './autopilot/week-strip';

const STEPS = ['Connect', 'Topics', 'First week'];

// Survives the OAuth round-trip and reloads, so nobody restarts at step 1.
const STEP_KEY = 'sociafy:onboardingStep';

/** "acme.com" → "https://acme.com"; the settings API wants a full URL. */
const normalizeUrl = (v: string) => {
  const t = v.trim();
  return !t || /^https?:\/\//i.test(t) ? t : `https://${t}`;
};

const fmt = (n: number) => n.toLocaleString('en-IN');
const nameOf = (p: Platform) => PLATFORMS.find((x) => x.id === p)?.name ?? p;
const listOf = (ps: Platform[]) => ps.map(nameOf).join(', ');
const mixLine = (m: Record<'text' | 'image' | 'video', number>) =>
  (['text', 'image', 'video'] as const).filter((k) => m[k]).map((k) => `${m[k]} ${k}`).join(' · ') || 'nothing';
/** TikTok, YouTube: video only, so 319 cr a post. Off for the first week unless the user picks them. */
const videoOnly = (p: Platform) => !supportsKind(p, 'text') && !supportsKind(p, 'image');

const PRESETS: { id: MixPreset; label: string }[] = [
  { id: 'text', label: 'Text-led' },
  { id: 'mixed', label: 'Mixed' },
  { id: 'video', label: 'Video-first' },
];

/** 409 `blocked` from /api/plan/generate → what to say and where the fix is. */
const BLOCKED: Record<string, { text: string; href?: string; cta?: string }> = {
  insufficient_credits: { text: 'Not enough credits to draft this week.', href: '/account/billing', cta: 'Top up' },
  credit_cap: { text: 'Your weekly credit cap is below this plan.', href: '/autopilot#ap-budget', cta: 'Raise the cap' },
  no_niches: { text: 'Pick at least one topic first.' },
  no_accounts: { text: 'None of your accounts can post right now.', href: '/settings/connections', cta: 'Connections' },
  no_allowed_platforms: { text: 'None of the picked accounts can post right now.', href: '/settings/connections', cta: 'Connections' },
};

type PlanDraft = { id: string; title: string | null; plannedAt: string | null; rendering: boolean; media: { url: string; mimeType: string; posterUrl?: string }[] };
type PlanPayload = { generating: boolean; review: PlanDraft[]; scheduled?: { draftId: string; scheduledAt: string; text: string; media: PlanDraft['media'] }[] };

/** This week's posts: drafts waiting for review, plus ones already scheduled ("Post automatically"), one per draft. */
const postsOf = (p: PlanPayload | null | undefined): PlanDraft[] => {
  if (!p) return [];
  const seen = new Set(p.review.map((d) => d.id));
  const queued = (p.scheduled ?? []).flatMap((s) => {
    if (seen.has(s.draftId)) return [];
    seen.add(s.draftId);
    return [{ id: s.draftId, title: s.text.split('\n')[0].slice(0, 80) || null, plannedAt: s.scheduledAt, rendering: false, media: s.media }];
  });
  return [...p.review, ...queued];
};
type Run = {
  phase: 0 | 1 | 2;
  startedAt: number;
  /** The slots the 202 reserved; null after a 409 `running` (the enable-kick holds them). */
  slots: { at: string; kind: 'text' | 'image' | 'video' }[] | null;
  baseline: Set<string>;
};

const thumbOf = (d: PlanDraft) => {
  const m = d.media?.[0];
  return m ? (m.mimeType.startsWith('image/') ? m.url : m.posterUrl ?? null) : null;
};

const Onboarding: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [step, setStepState] = useState(0);
  const setStep = (n: number) => {
    window.sessionStorage.setItem(STEP_KEY, String(n));
    setStepState(n);
    document.getElementById('main')?.scrollTo({ top: 0 });
  };
  // Back from OAuth → the Connect step; a plain reload → where they were.
  const { flash, dismiss } = useOAuthReturn((fromOAuth) => {
    const saved = Number(window.sessionStorage.getItem(STEP_KEY));
    if (fromOAuth) window.sessionStorage.setItem(STEP_KEY, '0');
    else if (saved > 0 && saved <= STEPS.length - 1) setStepState(saved);
  });

  const [topics, setTopics] = useState<string[]>([]);
  const [website, setWebsite] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);

  const { data: accounts } = useApi<Account[]>('/api/accounts');
  const { data: settings } = useApi<{ niches: string[]; website: string | null }>('/api/agent/settings');
  const { data: credits } = useApi<{ balance: number }>('/api/credits');
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
  const healthy = useMemo(
    () => PLATFORMS.map((p) => p.id).filter((id) => (accounts ?? []).some((a) => a.platform === id && isHealthy(healthFor(a, now)))),
    [accounts, now],
  );

  // ---- Step 3 plan ----
  const [picked, setPicked] = useState<Platform[] | null>(null);
  const sel = picked ?? healthy.filter((p) => !videoOnly(p));
  const recommended = Math.min(7, Math.max(3, recommendPlan(sel, topics).cadencePerWeek));
  const [totalPick, setTotal] = useState<number | null>(null);
  const total = totalPick ?? recommended;
  const [preset, setPreset] = useState<MixPreset>('text');
  const [autoPost, setAutoPost] = useState(true);
  const mix = mixFor(preset, total, sel);
  const cost = estimateWeeklyBurn({ platforms: sel, cadencePerWeek: total, postsPerWeekByContentType: mix }).weekly;
  const costOf = (p: MixPreset) => estimateWeeklyBurn({ platforms: sel, cadencePerWeek: total, postsPerWeekByContentType: mixFor(p, total, sel) }).weekly;
  const balance = credits?.balance ?? null;
  const short = balance !== null && cost > balance;
  const forced = sel.filter((p) => !supportsKind(p, 'text') && (preset === 'text'));

  const [from, setFrom] = useState<Date | null>(null);
  useEffect(() => { if (step === 2) queueMicrotask(() => setFrom(new Date())); }, [step]);

  const [run, setRun] = useState<Run | null>(null);
  const [filed, setFiled] = useState(false);
  const { data: live } = useApi<PlanPayload>(run?.phase === 2 ? '/api/plan?days=7' : null, { refreshInterval: 4_000 });
  const fresh = run && live ? postsOf(live).filter((d) => !run.baseline.has(d.id)) : [];
  const developed = fresh.filter((d) => !d.rendering);

  /** What the week card shows: projected chips, then reserved slots filling in with real drafts. */
  const strip: StripSlot[] = (() => {
    if (!from) return [];
    const reserved = run?.slots ?? (run ? projectWeek({ from, mix }).map((s) => ({ at: s.at.toISOString(), kind: s.kind })) : null);
    if (!reserved) return projectWeek({ from, mix }).map((s, i) => ({ key: `p${i}`, at: s.at.toISOString(), kind: s.kind, state: 'proj' }));
    const left = [...fresh];
    const out: StripSlot[] = reserved.map((s, i) => {
      const t = new Date(s.at).getTime();
      const j = left.findIndex((d) => d.plannedAt && Math.abs(new Date(d.plannedAt).getTime() - t) < 60_000);
      const d = j >= 0 ? left.splice(j, 1)[0] : null;
      return d
        ? { key: d.id, at: s.at, kind: s.kind, state: d.rendering ? 'drafting' : 'ready', title: d.title, thumb: thumbOf(d) }
        : { key: `r${i}`, at: s.at, kind: s.kind, state: run?.phase === 2 ? 'drafting' : 'proj' };
    });
    // Drafts the planner put somewhere else (e.g. the enable-kick won the race) still show up.
    for (const d of left) {
      out.push({ key: d.id, at: d.plannedAt ?? new Date().toISOString(), kind: d.media?.[0]?.mimeType.startsWith('video/') ? 'video' : d.media?.length ? 'image' : 'text', state: d.rendering ? 'drafting' : 'ready', title: d.title, thumb: thumbOf(d) });
    }
    return out;
  })();
  const n = run ? strip.length : mix.text + mix.image + mix.video;

  // The success screen comes as soon as the first post has developed; the rest keep drafting behind it.
  const firstIn = developed.length > 0;
  useEffect(() => {
    if (!firstIn || filed) return;
    const t = setTimeout(() => setFiled(true), 1_400);
    return () => clearTimeout(t);
  }, [firstIn, filed]);

  // On phones the week card sits below the plan: once drafting starts, bring it into view.
  const drafting = !!run;
  useEffect(() => {
    if (!drafting) return;
    const card = document.querySelector('.ob-week');
    const main = document.getElementById('main');
    if (!card || !main) return;
    const top = card.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 12;
    if (top > main.scrollTop) main.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [drafting]);

  // Elapsed clock for the phase list.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!run) return;
    const id = setInterval(() => setTick(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [run]);
  const elapsed = run && tick ? Math.max(0, Math.floor((tick - run.startedAt) / 1000)) : 0;
  const stalled = run?.phase === 2 && !firstIn && elapsed > 120 && live && !live.generating;

  const leave = () => {
    window.sessionStorage.removeItem(STEP_KEY);
    onDone();
  };

  const saveTopics = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch('/api/agent/settings', { niches: topics, website: normalizeUrl(website) });
      setStep(2);
    } catch (e) {
      setError(`Couldn’t save your topics. ${friendlyApiError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // The only PATCH that sends enabled:true — that is what stamps onboardedAt.
  const draftWeek = async () => {
    setError(null);
    const started: Run = { phase: 0, startedAt: Date.now(), slots: null, baseline: new Set() };
    setRun(started);
    setTick(Date.now());
    // Anything already waiting (a re-run of setup) isn't "this week arriving".
    const before = await fetch('/api/plan?days=7', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as PlanPayload | null;
    const baseline = new Set(postsOf(before).map((d) => d.id));
    try {
      await apiPatch('/api/agent/settings', {
        enabledPlatforms: sel,
        postsPerWeekByContentType: mix,
        postsPerWeekByPlatform: platformCaps(sel, topics, total),
        autoPublishThreshold: autoPost ? 1 : 101, // 1 = every rated draft posts at its slot; 101 = waits for approval
        planHorizonDays: 7,
        enabled: true,
      });
    } catch (e) {
      setRun(null);
      setError(`Couldn’t save your plan. ${friendlyApiError(e)}`);
      return;
    }
    setRun({ ...started, phase: 1, baseline });
    try {
      const g = await apiPost<{ status: string; slots?: Run['slots'] }>('/api/plan/generate', { horizonDays: 7 });
      setRun({ ...started, phase: 2, baseline, slots: g.slots ?? null });
    } catch (e) {
      const m = (e instanceof Error ? e.message : '').match(/^409:\s*(\{[\s\S]*\})/);
      let body: { status?: string; reason?: string } = {};
      try { body = m ? JSON.parse(m[1]) : {}; } catch { /* not JSON */ }
      // The enable-kick already holds the lease and is drafting this week: same thing, just watch.
      if (body.status === 'running') { setRun({ ...started, phase: 2, baseline }); return; }
      setRun(null);
      const b = body.status === 'blocked' ? BLOCKED[body.reason ?? ''] : null;
      setError(b
        ? <>{b.text} {b.href && <Link href={b.href}>{b.cta}</Link>}</>
        : `Couldn’t start drafting. ${body.reason ?? friendlyApiError(e)}`);
    }
  };

  const busy = saving || (!!run && run.phase < 2);
  const started = !!run;

  // ---- Pinned bar: the reason on the left, the action on the right ----
  let msg: React.ReactNode;
  let primary: React.ReactNode;
  if (step === 0) {
    msg = healthy.length ? <><b>{healthy.length} connected</b> · {listOf(healthy)}</> : 'Connect at least one account to continue.';
    primary = <Button variant="primary" onClick={() => setStep(1)} disabled={!healthy.length}>Continue</Button>;
  } else if (step === 1) {
    msg = topics.length
      ? <><b>{topics.length} topic{topics.length === 1 ? '' : 's'}</b> · we look for fresh news in these every hour</>
      : 'Pick at least one topic. It’s what Sociafy writes about.';
    primary = <Button variant="primary" onClick={saveTopics} busy={saving} disabled={!topics.length}>{saving ? 'Saving…' : 'Continue'}</Button>;
  } else if (filed) {
    msg = <><b>Filed.</b> Autopilot is on and keeps next week ready too.</>;
    primary = <Button variant="primary" onClick={leave}>{autoPost ? 'Open This week' : 'Review on Home'}</Button>;
  } else if (run) {
    msg = run.phase === 0 ? <b>Saving your plan…</b>
      : run.phase === 1 ? <b>Reserving {n} slots…</b>
      : stalled ? <><b>Taking longer than usual.</b> You can leave; posts appear on Home as they’re ready.</>
      : <><b>Writing posts · {developed.length} of {n} ready.</b> Images take about a minute each; you can leave, drafting continues.</>;
    primary = <Button onClick={leave} busy={run.phase < 2}>Go to Home</Button>;
  } else {
    msg = !sel.length ? 'Pick at least one place to post.'
      : short ? <>Not enough credits for this plan. <Link href="/account/billing">Top up</Link> or pick Text-led.</>
      : <><b>≈ {fmt(cost)} cr this week</b>{balance !== null && <> · you have {fmt(balance)} cr</>}</>;
    primary = (
      <Button variant="primary" cost={cost} onClick={draftWeek} disabled={!sel.length || short || !from}>Draft my week</Button>
    );
  }

  return (
    <main id="main" className="page ob">
      <div className={`page-fill ob-inner${step === 2 ? ' is-wide' : ''}`}>
        <header className="ob-top">
          <div className="brand ob-brand">
            <div className="brand-mark">S</div>
            <span className="brand-name">sociafy<span className="dot">.</span></span>
          </div>
          <button type="button" className="btn ghost sm ob-later" onClick={leave} disabled={started} title={started ? 'Setup is done; drafting has started.' : undefined}>
            Set up later
          </button>
        </header>

        <nav className="ob-prog" aria-label="Setup progress">
          <ol>
            {STEPS.map((label, i) => (
              <li key={label} className={i === step ? 'is-now' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>
                <span className="ob-n">{i < step ? <Icon name="check" size={10} strokeWidth={2} /> : i + 1}</span>{label}
              </li>
            ))}
          </ol>
          <div className="ob-bar"><i style={{ clipPath: `inset(0 ${100 - ((step + 1) * 100) / 3}% 0 0)` }} /></div>
        </nav>

        <div className="ob-pane" key={step}>
          {step === 0 && (
            <>
              <h1>Where should Sociafy post?</h1>
              <p className="lede">Nothing goes out until you approve it. You can disconnect any time.</p>
              <ConnectionsList mode="onboarding" next="/onboarding" flash={flash} onDismissFlash={dismiss} />
            </>
          )}

          {step === 1 && (
            <>
              <h1>What does your business post about?</h1>
              <p className="lede">Your website and topics steer every draft. Change them later in Autopilot.</p>
              <div className="ob-field">
                <label htmlFor="ob-site">Website <span>· optional</span></label>
                <input
                  id="ob-site" className="input" type="text" inputMode="url" autoComplete="url"
                  value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="yourbusiness.com"
                />
                <p className="ap-note">We read it once to learn your products and voice. Free.</p>
              </div>
              <div className="ob-field">
                <label htmlFor="ob-topic">Topics</label>
                <TopicPicker id="ob-topic" value={topics} onChange={setTopics} />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h1>Plan your first week</h1>
              <p className="lede">Sociafy drafts these for you. {autoPost ? 'They post at their planned times; until then you can edit or skip them in This week.' : 'You approve them in This week; nothing posts on its own.'}</p>
              <div className="ob-plan">
                <div className="ap-card ob-plan-card">
                  <div>
                    <div className="ap-lbl"><b>Post to</b><span>Tap to add or remove</span></div>
                    <div className="ob-pills">
                      {healthy.map((p) => {
                        const meta = PLATFORMS.find((x) => x.id === p)!;
                        const on = sel.includes(p);
                        return (
                          <button
                            key={p} type="button" className="ob-pill" aria-pressed={on} disabled={started}
                            onClick={() => setPicked(on ? sel.filter((x) => x !== p) : [...sel, p])}
                          >
                            <Pglyph p={meta.short} size="lg" />{meta.name}
                            {videoOnly(p) && <span className="seg-aside">{fmt(draftCost('video'))} cr/post</span>}
                          </button>
                        );
                      })}
                      {!healthy.length && <span className="ap-note">No connected accounts. Go back to Connect.</span>}
                    </div>
                    {healthy.some(videoOnly) && (
                      <p className="ap-note">
                        {listOf(healthy.filter(videoOnly))} take{healthy.filter(videoOnly).length === 1 ? 's' : ''} video only, {fmt(draftCost('video'))} cr a post. Off for your first week; tap to include.
                      </p>
                    )}
                    {healthy.includes('linkedin') && <p className="ap-note">LinkedIn posts go to your personal profile.</p>}
                  </div>
                  <div className="ap-row">
                    <div>
                      <div className="ap-lbl ap-lbl--tight"><b>Posts this week</b></div>
                      <span className="ap-note">Recommended for your topics: {recommended}</span>
                    </div>
                    <Stepper value={total} min={1} max={14} onChange={setTotal} label="Posts" disabled={started} />
                  </div>
                  <div>
                    <div className="ap-lbl"><b>Formats</b><span>Cost this week</span></div>
                    <div className="ap-costs">
                      <Seg
                        className="full ap-seg-costs" label="Formats" value={preset} onChange={setPreset}
                        options={PRESETS.map((p) => ({ id: p.id, disabled: started, label: <>{p.label} <small className="seg-aside">{fmt(costOf(p.id))} cr</small></> }))}
                      />
                    </div>
                    <p className="ap-note ap-mt">
                      {mixLine(mix)}
                      {forced.length > 0 && ` · ${listOf(forced)} need${forced.length === 1 ? 's' : ''} an image or video, so one is included`}
                    </p>
                  </div>
                  <div className="ap-row">
                    <div>
                      <div className="ap-lbl ap-lbl--tight"><b>Before posting</b></div>
                      <span className="ap-note">Change it any time in Autopilot</span>
                    </div>
                    <Seg<'auto' | 'ask'>
                      size="sm" label="Before posting" value={autoPost ? 'auto' : 'ask'} onChange={(v) => setAutoPost(v === 'auto')}
                      options={[{ id: 'auto', disabled: started, label: <>Post automatically <small className="seg-aside">default</small></> }, { id: 'ask', disabled: started, label: 'Ask me first' }]}
                    />
                  </div>
                </div>

                <div className={`ap-card ob-week${filed ? ' is-filed' : ''}`}>
                  <div className="ap-wkhd"><b>Your week</b>{from && <span className="ap-note ap-mono">{weekRange(from)}</span>}</div>
                  {run && !filed && (
                    <ul className="ap-phases" aria-live="polite">
                      {['Saving your plan', `Reserving ${n} slots`, `Writing posts (${developed.length} of ${n})`].map((p, i) => (
                        <li key={i} className={i < run.phase ? 'is-done' : i === run.phase ? 'is-now' : ''}><i />{p}</li>
                      ))}
                      <li className="ap-phase-time">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</li>
                    </ul>
                  )}
                  {/* Filed: the strip files itself away and the summary lands in its place; drafting goes on behind it. */}
                  <div className="ob-stack">
                    <div className="ob-weekwrap" aria-hidden={filed || undefined}>{from && <WeekStrip from={from} slots={strip} readyLabel={autoPost ? 'Scheduled' : 'Ready to review'} />}</div>
                    {filed && (
                      <div className="ob-filed" role="status">
                        <div className="ob-tick"><Icon name="check" size={20} strokeWidth={1.8} /></div>
                        <h3>Your first week is on its way</h3>
                        <span className="ob-pillsum">{n} posts · {from && weekRange(from)} · {listOf(sel)}</span>
                        <p className="ap-note">
                          {developed.length} of {n} ready{developed.length < n ? '; the rest keep drafting' : ''}. Images take about a minute each.
                          You can leave; drafting continues. {autoPost ? 'Each post goes out at its time; edit or skip it in This week before then.' : 'Nothing posts until you approve it in This week.'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {error && (
            <div role="alert" className="conn-banner conn-banner--err ob-error">
              <span className="conn-banner__text">{error}</span>
              <button type="button" className="btn ghost sm" onClick={() => setError(null)} aria-label="Dismiss">
                <Icon name="x" size={12} />
              </button>
            </div>
          )}
        </div>

        <PinBar msg={<span className="ob-msg" key={`${step}-${run?.phase}-${filed}`}>{msg}</span>}>
          {step > 0 && (
            <Button variant="ghost" onClick={() => { setError(null); setStep(step - 1); }} disabled={busy || started}>Back</Button>
          )}
          {primary}
        </PinBar>
      </div>
    </main>
  );
};

export default Onboarding;
