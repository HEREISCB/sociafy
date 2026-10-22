'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon, Pglyph } from '../icons';
import { apiPatch, friendlyApiError, useApi } from '../../lib/ui/fetcher';
import { PLATFORMS } from '../../lib/ui/platforms';
import type { Niche, Platform, DraftMedia } from '../../lib/db/schema';
import type { AgentStatus } from '../../lib/agent/status';
import { draftCost, estimateWeeklyBurn, weeksOfRunway } from '../../lib/credits/estimator';
import { mixFor, platformCaps, presetOf, type MixPreset } from '../../lib/agent/recommend';
import { projectWeek } from '../../lib/agent/week';
import { postKind, supportsKind, type PostKind } from '../../lib/platforms/capabilities';
import { motionReady, type AutopilotVideoStyle, type BrandKit, type BrandProfile } from '../../lib/brand/kit';
import { Saved, Stepper, TopicPicker } from './controls';
import { Button, Seg, useToast } from '../ui';
import WeekStrip, { weekRange, type StripSlot } from './week-strip';

type Mix = { text: number; image: number; video: number };

type Settings = {
  enabled: boolean;
  autoPublishThreshold: number;
  brandSafetyStrict: boolean;
  niches: Niche[];
  quietHours: { start: string; end: string } | null;
  enabledPlatforms: Platform[];
  postsPerWeekByContentType: Mix;
  weeklyCreditCap: number | null;
  planHorizonDays: number;
};

/** AgentStatus as it arrives over JSON — Dates are strings by then. */
type StatusPayload = Omit<AgentStatus, 'pendingReview'> & {
  pendingReview: { id: string; title: string | null; createdAt: string; rendering: boolean }[];
};

type PlanPayload = {
  generating: boolean;
  review: { id: string; title: string | null; plannedAt: string | null; rendering: boolean; media: DraftMedia[] }[];
  scheduled: { id: string; draftId: string; scheduledAt: string; text: string; media: DraftMedia[] }[];
  counts: { review: number };
};

type BrandPayload = { kit: BrandKit; profile: BrandProfile; motion?: boolean };
type Section = 'status' | 'make' | 'where' | 'budget' | 'rules';

/** "Post automatically" threshold; new users start on 101 ("Ask me first"). */
const AUTO_THRESHOLD = 80;
const DAY = 24 * 60 * 60 * 1000;

const BLOCKED: Record<NonNullable<AgentStatus['blocked']>, { text: string; href: string; cta: string }> = {
  no_niches: { text: 'Pick at least one topic.', cta: 'Topics', href: '#ap-make' },
  no_platforms: { text: 'No connected account is switched on.', cta: 'Where it posts', href: '#ap-where' },
  no_credits: { text: 'Out of credits.', cta: 'Top up', href: '/account/billing' },
  credit_cap: { text: 'Weekly credit cap reached.', cta: 'Raise the cap', href: '#ap-budget' },
  no_trends: { text: 'Nothing fresh in your topics yet. It checks again every hour.', cta: 'Edit topics', href: '#ap-make' },
};

const PRESETS: { id: MixPreset; label: string }[] = [
  { id: 'text', label: 'Text-led' },
  { id: 'mixed', label: 'Mixed' },
  { id: 'video', label: 'Video-first' },
];

const fmt = (n: number) => n.toLocaleString('en-IN');
const mixLine = (m: Mix) => (['text', 'image', 'video'] as const).filter((k) => m[k]).map((k) => `${m[k]} ${k}`).join(' · ') || 'nothing';
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const kindOf = (media: DraftMedia[] | null | undefined, rendering = false): PostKind => (rendering ? 'video' : postKind(media));
const thumbOf = (media: DraftMedia[] | null | undefined) => {
  const m = media?.[0];
  return m ? (m.mimeType.startsWith('image/') ? m.url : m.posterUrl ?? null) : null;
};

/** What a platform takes, in a few words. */
function takes(p: Platform) {
  const k = (['text', 'image', 'video'] as const).filter((x) => supportsKind(p, x));
  if (k.length === 3) return 'Text, image and video';
  if (k.length === 1) return `${k[0][0].toUpperCase()}${k[0].slice(1)} only`;
  return `${k[0][0].toUpperCase()}${k[0].slice(1)} and ${k[1]} only`;
}

export default function PlanSettings() {
  const { data: settings, error: settingsError, mutate: refetchSettings, unauth } = useApi<Settings>('/api/agent/settings');
  const { data: accounts } = useApi<{ platform: Platform }[]>('/api/accounts');
  const { data: brand, mutate: refetchBrand } = useApi<BrandPayload>('/api/brand-kit');
  const { data: plan, mutate: refetchPlan } = useApi<PlanPayload>('/api/plan?days=7', { refreshInterval: (d) => (d && 'generating' in d && d.generating ? 4_000 : 60_000) });
  const { data: status, mutate: refetchStatus } = useApi<StatusPayload>('/api/agent/status', { refreshInterval: plan?.generating ? 4_000 : 60_000 });
  const toast = useToast();

  // Local copies so controls respond instantly; the server stays the source of truth.
  const [enabled, setEnabled] = useState(false);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [niches, setNiches] = useState<string[]>([]);
  const [total, setTotal] = useState(4);
  const [quiet, setQuiet] = useState({ start: '22:00', end: '07:00' });
  const [capOn, setCapOn] = useState(false);
  const [cap, setCap] = useState('');
  useEffect(() => {
    if (!settings) return;
    // Re-sync local copies to each fresh server read.
    setEnabled(settings.enabled);
    setPlatforms(settings.enabledPlatforms ?? []);
    setNiches(settings.niches ?? []);
    const m = settings.postsPerWeekByContentType;
    setTotal(m ? m.text + m.image + m.video : 4);
    setQuiet(settings.quietHours ?? { start: '22:00', end: '07:00' });
    setCapOn(typeof settings.weeklyCreditCap === 'number');
    setCap(typeof settings.weeklyCreditCap === 'number' ? String(settings.weeklyCreditCap) : '');
  }, [settings]);

  const [saved, setSaved] = useState<Partial<Record<Section, number>>>({});
  const [errs, setErrs] = useState<Partial<Record<Section, { msg: string; retry: () => void }>>>({});

  /** Every settings write. Returns whether it landed; a failure shows in its section with Retry. */
  const persist = async (section: Section, patch: Record<string, unknown>): Promise<boolean> => {
    setErrs((e) => ({ ...e, [section]: undefined }));
    try {
      await apiPatch('/api/agent/settings', patch);
      await Promise.all([refetchSettings(), refetchStatus(), refetchPlan()]);
      setSaved((s) => ({ ...s, [section]: Date.now() }));
      return true;
    } catch (e) {
      setErrs((x) => ({ ...x, [section]: { msg: friendlyApiError(e), retry: () => void persist(section, patch) } }));
      return false;
    }
  };

  const connected = [...new Set((accounts ?? []).map((a) => a.platform))];
  const savedMix = settings?.postsPerWeekByContentType ?? { text: total, image: 0, video: 0 };
  const savedPreset = presetOf(savedMix, platforms);
  const [presetPick, setPreset] = useState<MixPreset | null>(null);
  const preset = presetPick ?? savedPreset;
  // Re-projected immediately as the user changes volume, format or platforms.
  const mix = preset ? mixFor(preset, total, platforms) : savedMix;
  const burnOf = (m: Mix) => estimateWeeklyBurn({ platforms, cadencePerWeek: total, postsPerWeekByContentType: m }).weekly;
  const burn = burnOf(mix);
  const locked = !!unauth || !settings;
  const horizon = settings?.planHorizonDays ?? 7;
  const auto = (settings?.autoPublishThreshold ?? 101) <= 100;
  const balance = status?.balance ?? null;

  /** Platforms, niches and the weekly number all feed the derived per-platform caps and the mix. */
  const savePlan = (next: { platforms?: Platform[]; niches?: string[]; total?: number; preset?: MixPreset }) => {
    const p = next.platforms ?? platforms;
    const n = next.niches ?? niches;
    const t = next.total ?? total;
    const pr = next.preset ?? preset ?? 'mixed';
    return persist(next.platforms ? 'where' : 'make', {
      ...(next.platforms && { enabledPlatforms: p }),
      ...(next.niches && { niches: n }),
      postsPerWeekByContentType: mixFor(pr, t, p),
      postsPerWeekByPlatform: platformCaps(p, n, t),
    });
  };

  const setOn = async (next: boolean, undoable: boolean) => {
    setEnabled(next);
    // Snap back if the server didn't take it — "on" when it isn't is the worst lie here.
    if (!(await persist('status', { enabled: next }))) { setEnabled(!next); return; }
    if (!next && undoable) toast('Autopilot paused', { undo: () => void setOn(true, false) });
    else if (next) toast('Autopilot is on · drafting what’s missing');
  };

  const togglePlatform = async (p: Platform) => {
    const prev = platforms;
    const next = prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p];
    setPlatforms(next);
    if (!(await savePlan({ platforms: next }))) { setPlatforms(prev); return; }
    const name = PLATFORMS.find((x) => x.id === p)?.name ?? p;
    if (!next.includes(p)) toast(`${name} switched off`, { undo: () => { setPlatforms(prev); void savePlan({ platforms: prev }); } });
  };

  const changeNiches = async (next: string[]) => {
    const prev = niches;
    setNiches(next);
    if (!(await savePlan({ niches: next }))) setNiches(prev);
  };

  const totalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeTotal = (t: number) => {
    setTotal(t);
    if (totalTimer.current) clearTimeout(totalTimer.current);
    totalTimer.current = setTimeout(() => void savePlan({ total: t }), 600);
  };

  const changePreset = async (pr: MixPreset) => {
    setPreset(pr);
    await savePlan({ preset: pr });
    setPreset(null);
  };

  const saveCap = (on: boolean, raw: string) => {
    const v = on ? Math.max(0, parseInt(raw, 10) || 0) : null;
    if (v === (settings?.weeklyCreditCap ?? null)) return;
    void persist('budget', { weeklyCreditCap: v });
  };

  /** Lives in the brand kit (kit.video.autopilot) — agent_settings has no column for it. */
  const saveVideoStyle = async (autopilot: AutopilotVideoStyle) => {
    setErrs((e) => ({ ...e, make: undefined }));
    try {
      await refetchBrand(await apiPatch<BrandPayload>('/api/brand-kit', { video: { ...brand?.kit.video, autopilot } }), { revalidate: false });
      setSaved((s) => ({ ...s, make: Date.now() }));
    } catch (e) {
      setErrs((x) => ({ ...x, make: { msg: friendlyApiError(e), retry: () => void saveVideoStyle(autopilot) } }));
    }
  };

  // ---- This week strip: real posts in the window, then projected chips for what's missing ----
  const [from, setFrom] = useState<Date | null>(null);
  useEffect(() => { queueMicrotask(() => setFrom(new Date())); }, []);
  const end = from ? from.getTime() + 7 * DAY : 0;
  const inWeek = (iso: string | null) => !!iso && !!from && new Date(iso).getTime() >= from.getTime() && new Date(iso).getTime() < end;
  const real: StripSlot[] = [];
  if (plan && from) {
    for (const d of plan.review) {
      if (inWeek(d.plannedAt)) real.push({ key: d.id, at: d.plannedAt!, kind: kindOf(d.media, d.rendering), state: d.rendering ? 'drafting' : 'ready', title: d.title, thumb: thumbOf(d.media) });
    }
    const seenDraft = new Set<string>();
    for (const p of plan.scheduled) {
      if (seenDraft.has(p.draftId) || !inWeek(p.scheduledAt)) continue;
      seenDraft.add(p.draftId);
      real.push({ key: p.draftId, at: p.scheduledAt, kind: kindOf(p.media), state: 'ready', title: p.text.split('\n')[0], thumb: thumbOf(p.media) });
    }
  }
  // What was already there when the page loaded shows sharp; later arrivals develop in.
  const [still, setStill] = useState<Set<string> | null>(null);
  if (plan && from && !still) setStill(new Set(real.map((s) => s.key)));
  const have = real.reduce((h, s) => ({ ...h, [s.kind]: h[s.kind] + 1 }), { text: 0, image: 0, video: 0 } as Mix);
  const projected: StripSlot[] = from && enabled
    ? projectWeek({ from, mix, have, taken: real.map((s) => new Date(s.at)), quiet: settings?.quietHours })
      .map((s, i) => ({ key: `p${i}-${s.kind}`, at: s.at.toISOString(), kind: s.kind, state: plan?.generating ? 'drafting' : 'proj' }))
    : [];
  const strip = [...real.map((s) => ({ ...s, still: !!still?.has(s.key) })), ...projected];

  // ---- Status line ----
  const blocked = enabled && status?.blocked ? BLOCKED[status.blocked] : null;
  const review = plan?.counts.review ?? status?.pendingReview.length ?? 0;
  const needsSetup = !!settings && niches.length === 0;
  const period = horizon === 30 ? 'month' : 'week';
  let line: React.ReactNode;
  if (!settings) line = settingsError ? 'Couldn’t load your plan. Don’t change anything until it loads.' : 'Loading your plan…';
  else if (!enabled) line = needsSetup ? 'Pick at least one topic below to turn it on.' : 'Paused. Nothing is drafted or posted until you turn it on.';
  else if (blocked) line = <>{blocked.text} <a href={blocked.href}>{blocked.cta}</a></>;
  else if (!status) line = `Keeps a ${period} of posts ready`;
  else if (plan?.generating) line = `Drafting now · ${Math.min(status.ready, status.target)} of ${status.target} ready`;
  else if (status.planned >= status.target) line = `This ${period} is full · ${review} ${review === 1 ? 'draft' : 'drafts'} waiting for you`;
  else line = `${Math.min(status.ready, status.target)} of ${status.target} ready${status.nextTopUpAt ? ` · next top-up ${when(status.nextTopUpAt)}` : ''}`;

  const motionOn = !!brand?.motion;
  const motionOk = !!brand && motionReady(brand.kit, brand.profile);
  const capNum = capOn ? Math.max(0, parseInt(cap, 10) || 0) : null;
  const used = status?.creditsThisWeek ?? 0;
  const meterOf = capNum ?? burn;
  const weeks = balance !== null ? weeksOfRunway(burn, balance) : null;
  const monthPosts = Math.ceil((total * 30) / 7);

  const Err = ({ s }: { s: Section }) => errs[s] ? (
    <p className="ap-err" role="alert">
      That change wasn’t saved. {errs[s]!.msg}
      <button type="button" className="btn sm" onClick={errs[s]!.retry}>Retry</button>
    </p>
  ) : null;

  return (
    <div className="ap">
      {unauth && <p className="ap-err"><Link href="/sign-in?next=/autopilot">Sign in</Link> to set up your plan.</p>}

      <div className="ap-status">
        <div className="ap-status-st">
          <b><span className={`ap-dot${enabled ? (blocked ? ' is-warn' : ' is-on') : ''}`} aria-hidden="true" />Autopilot is {enabled ? (blocked ? 'stuck' : 'on') : 'paused'}</b>
          <span role="status">{line}</span>
          <Err s="status" />
        </div>
        <div className="ap-status-btns">
          {enabled ? (
            <Button onClick={() => setOn(false, true)} disabled={locked}><Icon name="pause" size={13} />Pause</Button>
          ) : (
            <Button variant="primary" cost={burn} onClick={() => setOn(true, false)} disabled={locked || needsSetup} title="Credits a week at this plan">
              Turn on
            </Button>
          )}
          {review > 0
            ? <Link className={`btn${enabled ? ' primary' : ''}`} href="/dashboard">Review {review}</Link>
            : <Button disabled title="Nothing is waiting for you">Review 0</Button>}
        </div>
      </div>

      <div className="ap-grid">
        <aside className="ap-card ap-side" aria-labelledby="ap-week-h">
          <div className="ap-wkhd"><b id="ap-week-h">This week</b>{from && <span className="ap-note ap-mono">{weekRange(from)}</span>}</div>
          {from && <WeekStrip from={from} slots={strip} />}
          {!enabled && settings && <p className="ap-note ap-mt">Paused: nothing new is projected until you turn it on.</p>}
          <div className="ap-weeksum">
            <span>{total} posts · {mixLine(mix)}</span>
            <span key={burn} className="ap-fade">≈ <span className="ap-mono">{fmt(burn)}</span> cr / week</span>
          </div>
        </aside>

        <div className="ap-main">
          <section className="ap-card ap-sec" id="ap-make" aria-labelledby="ap-make-h">
            <div className="ap-hdr"><h2 id="ap-make-h">What to make <Saved at={saved.make ?? 0} /></h2></div>
            <div className="ap-item">
              <div className="ap-ih"><b>Topics</b><span className="ap-note">Checked for fresh news every hour</span></div>
              <TopicPicker value={niches} onChange={changeNiches} disabled={locked} />
            </div>
            <div className="ap-item">
              <div className="ap-ih"><b>Formats</b><span className="ap-note">Video drafts cost {fmt(draftCost('video'))} cr each</span></div>
              <div className="ap-costs">
                <Seg<MixPreset | 'custom'>
                  className="full ap-seg-costs" label="Formats" value={preset ?? 'custom'} onChange={(v) => v !== 'custom' && changePreset(v)}
                  options={PRESETS.map((p) => ({ id: p.id, disabled: locked, label: <>{p.label} <small className="seg-aside">{fmt(burnOf(mixFor(p.id, total, platforms)))} cr</small></> }))}
                />
              </div>
              <p className="ap-note">{preset ? 'This week' : 'Custom mix'}: {mixLine(mix)}</p>
            </div>
            <div className="ap-item">
              <div className="ap-ih">
                <b>Posts per week</b>
                <Stepper value={total} min={1} max={30} onChange={changeTotal} label="Posts" disabled={locked} />
              </div>
            </div>
            <div className="ap-item">
              <div className="ap-ih"><b>Video style</b></div>
              <Seg<AutopilotVideoStyle>
                label="Video style" value={brand?.kit.video?.autopilot ?? 'cinema'} onChange={saveVideoStyle}
                options={[
                  // Stored id stays 'cinema' (persisted in brand kits); it means a generated clip.
                  { id: 'cinema', label: 'AI video', disabled: locked || !brand },
                  { id: 'motion', label: 'Motion graphics', disabled: locked || !motionOn || !motionOk, title: !motionOn ? 'Not available yet' : !motionOk ? 'Needs brand name, logo and main colour' : undefined },
                  { id: 'mix', label: 'Mix', disabled: locked || !motionOn || !motionOk, title: !motionOn ? 'Not available yet' : !motionOk ? 'Needs brand name, logo and main colour' : undefined },
                ]}
              />
              <p className="ap-note">
                {!motionOn ? 'Motion graphics aren’t available yet, so video posts use AI video.'
                  : !motionOk ? <>Motion graphics need your brand name, logo and main colour. <Link href="/settings/brand">Brand kit</Link></>
                  : 'Mix alternates AI video and motion graphics.'}
              </p>
            </div>
            <Err s="make" />
          </section>

          <section className="ap-card ap-sec" id="ap-where" aria-labelledby="ap-where-h">
            <div className="ap-hdr">
              <h2 id="ap-where-h">Where it posts <Saved at={saved.where ?? 0} /></h2>
              <Link className="ap-note ap-link" href="/settings/connections">Manage connections</Link>
            </div>
            <ul className="ap-plist">
              {PLATFORMS.map((p) => {
                const on = connected.includes(p.id);
                return (
                  <li key={p.id}>
                    <Pglyph p={p.short} size="lg" />
                    <span className="ap-plist-meta">
                      <b>{p.name}</b>
                      <span>{on ? takes(p.id) : `Not connected · ${takes(p.id)}`}{p.id === 'linkedin' ? ' · personal profile' : ''}</span>
                    </span>
                    {on ? (
                      <input
                        type="checkbox" role="switch" className="ap-switch" aria-label={`Post to ${p.name}`}
                        checked={platforms.includes(p.id)} disabled={locked} onChange={() => togglePlatform(p.id)}
                      />
                    ) : (
                      <Link className="btn sm" href="/settings/connections">Connect</Link>
                    )}
                  </li>
                );
              })}
            </ul>
            <Err s="where" />
          </section>

          <section className="ap-card ap-sec" id="ap-budget" aria-labelledby="ap-budget-h">
            <div className="ap-hdr">
              <h2 id="ap-budget-h">Budget <Saved at={saved.budget ?? 0} /></h2>
              <span className="ap-note">Balance <span className="ap-mono ap-ink">{balance === null ? '…' : `${fmt(balance)} cr`}</span></span>
            </div>
            <div className="ap-item">
              <div className="ap-ih">
                <b>Spent this week</b>
                <span className="ap-note">
                  <span className="ap-mono ap-ink">{fmt(used)}</span> {capNum !== null ? <>of <span className="ap-mono">{fmt(capNum)}</span> cr cap</> : <>cr · plan ≈ <span className="ap-mono">{fmt(burn)}</span> cr</>}
                </span>
              </div>
              <div className="ap-meter" role="meter" aria-label="Credits spent this week" aria-valuemin={0} aria-valuemax={meterOf} aria-valuenow={used}>
                <i style={{ clipPath: `inset(0 ${meterOf > 0 ? Math.max(0, 100 - (used / meterOf) * 100) : 100}% 0 0 round 999px)` }} />
              </div>
            </div>
            <div className="ap-item">
              <div className="ap-ih">
                <b>Weekly cap</b>
                <div className="ap-row">
                  <Seg<'on' | 'none'>
                    size="sm" label="Weekly cap" value={capOn ? 'on' : 'none'}
                    onChange={(v) => { const on = v === 'on'; setCapOn(on); const raw = cap || String(Math.max(50, Math.ceil(burn / 50) * 50)); setCap(raw); saveCap(on, raw); }}
                    options={[{ id: 'none', label: 'No cap', disabled: locked }, { id: 'on', label: 'Cap at', disabled: locked }]}
                  />
                  <input
                    className="input ap-capin" type="number" min={0} step={50} inputMode="numeric" aria-label="Weekly cap in credits"
                    value={cap} disabled={locked || !capOn} title={capOn ? undefined : 'Pick “Cap at” to set a limit'}
                    onChange={(e) => setCap(e.target.value)}
                    onBlur={() => saveCap(capOn, cap)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveCap(capOn, cap); }}
                  />
                </div>
              </div>
              <p className="ap-note">
                {weeks === null ? '' : weeks < 0 ? 'This plan costs nothing.' : `Your ${fmt(balance!)} cr covers about ${weeks} week${weeks === 1 ? '' : 's'} at this plan.`}
                {balance !== null && burn > balance && <> <Link href="/account/billing">Top up</Link></>}
              </p>
              {capNum !== null && burn > capNum && (
                <p className="ap-warn">This plan needs ≈{fmt(burn)} cr a week, above your {fmt(capNum)} cr cap. Autopilot stops when it hits the cap; raise it or pick a lighter format.</p>
              )}
            </div>
            <Err s="budget" />
          </section>

          <section className="ap-card ap-sec" id="ap-rules" aria-labelledby="ap-rules-h">
            <div className="ap-hdr"><h2 id="ap-rules-h">Rules <Saved at={saved.rules ?? 0} /></h2></div>
            <div className="ap-item">
              <div className="ap-ih">
                <b>Before posting</b>
                <Seg<'ask' | 'auto'>
                  size="sm" label="Before posting" value={auto ? 'auto' : 'ask'}
                  onChange={(v) => persist('rules', { autoPublishThreshold: v === 'auto' ? AUTO_THRESHOLD : 101 })}
                  options={[{ id: 'ask', label: 'Ask me first', disabled: locked }, { id: 'auto', label: 'Post automatically', disabled: locked }]}
                />
              </div>
              <p className="ap-note">{auto ? `Drafts scoring ${AUTO_THRESHOLD}+ post on their own; the rest wait for you.` : 'Every draft waits for your approval on Home.'}</p>
            </div>
            <div className="ap-item">
              <div className="ap-ih">
                <b>How often you visit</b>
                <Seg<'7' | '30'>
                  size="sm" label="How often you visit" value={horizon === 30 ? '30' : '7'}
                  onChange={(d) => persist('rules', { planHorizonDays: Number(d) })}
                  options={[
                    { id: '7', disabled: locked, label: <>Weekly <small className="seg-aside">{total} ready</small></> },
                    { id: '30', disabled: locked, label: <>Monthly <small className="seg-aside">{monthPosts} ready</small></> },
                  ]}
                />
              </div>
              <p className="ap-note">
                {horizon === 30 ? 'We keep a month of posts ready to review in one sitting.' : 'We keep a week of posts ready to review in one sitting.'}
                {' '}A month at once costs ≈{fmt(Math.ceil((burn * 30) / 7))} cr up front.
              </p>
            </div>
            <div className="ap-item">
              <div className="ap-ih">
                <b>Quiet hours</b>
                <div className="ap-times">
                  {(['start', 'end'] as const).map((k, i) => (
                    <React.Fragment key={k}>
                      {i === 1 && <span className="ap-note">to</span>}
                      <input
                        className="input" type="time" aria-label={`Quiet hours ${k}`} value={quiet[k]} disabled={locked}
                        onChange={(e) => setQuiet((q) => ({ ...q, [k]: e.target.value }))}
                        onBlur={() => quiet.start && quiet.end && (quiet.start !== settings?.quietHours?.start || quiet.end !== settings?.quietHours?.end) && persist('rules', { quietHours: quiet })}
                      />
                    </React.Fragment>
                  ))}
                </div>
              </div>
              <p className="ap-note">Nothing is scheduled inside these hours.</p>
            </div>
            <div className="ap-item">
              <label className="ap-ih ap-toggle">
                <span>
                  <b>Strict brand safety</b>
                  <span className="ap-note">Holds anything that names a competitor or makes an unverified claim.</span>
                </span>
                <input
                  type="checkbox" role="switch" className="ap-switch" checked={settings?.brandSafetyStrict ?? true} disabled={locked}
                  onChange={(e) => persist('rules', { brandSafetyStrict: e.target.checked })}
                />
              </label>
            </div>
            <div className="ap-item">
              <p className="ap-note">Brand name, website, voice and style guide live in your <Link href="/settings/brand">Brand kit</Link>.</p>
            </div>
            <Err s="rules" />
          </section>
        </div>
      </div>
    </div>
  );
}
