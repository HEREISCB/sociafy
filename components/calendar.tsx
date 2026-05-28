'use client';

import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { Icon } from './icons';
import { apiDelete, apiPatch, apiPost, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';

type QuickMode = 'text' | 'image' | 'video';
type QuickSlot = { day: number; hour: number };
type CalView = 'week' | 'list';

const HOURS = ['7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM'];

type ScheduledRow = {
  id: string;
  platform: Platform;
  scheduledAt: string;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';
  text: string;
  platformPostUrl?: string | null;
};

type CalEvent = {
  id: string;
  day: number;
  start: number;
  span: number;
  type: 'posted' | 'scheduled' | 'ai' | 'draft';
  plats: string[];
  title: string;
  time: string;
};

const platGlyphs: Record<string, string> = { ig: 'I', fb: 'f', x: 'X', li: 'in', tt: 'T', yt: 'Y' };

function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = (day + 6) % 7; // Monday-first
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function fmtRange(start: Date) {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const sM = start.toLocaleDateString(undefined, { month: 'short' });
  const eM = end.toLocaleDateString(undefined, { month: 'short' });
  if (sM === eM) return `${sM} ${start.getDate()} – ${end.getDate()}, ${start.getFullYear()}`;
  return `${sM} ${start.getDate()} – ${eM} ${end.getDate()}, ${start.getFullYear()}`;
}

/** Short timezone label for the calendar's leftmost header cell.
 *  IANA names like "Asia/Kolkata" are too long for the 64px column and end
 *  up looking like empty space; "GMT+5:30" / "IST" fit and read clearly. */
function shortTzLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date());
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (tz) return tz;
  } catch { /* fall through */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface CalendarPageProps {
  /** Optional handler for the "New post" button — when provided, the button
   *  hands off to the compose surface. Falls back to a /dashboard?tab=compose
   *  navigation when omitted so the calendar stays usable in isolation. */
  onCompose?: () => void;
}

const CalendarPage: React.FC<CalendarPageProps> = ({ onCompose }) => {
  const slotH = 48;
  // Week-grid is unusable below ~900px (7 columns + time gutter don't fit).
  // We subscribe to the viewport so flipping the phone orientation re-evaluates.
  // SSR snapshot is `false` so server output always matches first client paint.
  const isNarrow = useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(max-width: 900px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(max-width: 900px)').matches,
    () => false,
  );
  const [viewOverride, setViewOverride] = useState<CalView | null>(null);
  const view: CalView = viewOverride ?? (isNarrow ? 'list' : 'week');
  const setView = setViewOverride;
  const [cursor, setCursor] = useState(() => startOfWeek(new Date()));
  const weekStart = cursor;
  const weekEnd = new Date(cursor);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const today = new Date();
  const todayIdx = ((today.getDay() + 6) % 7);
  const nowOffset = (today.getHours() + today.getMinutes() / 60 - 7) * slotH;

  const days = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(cursor);
    d.setDate(d.getDate() + i);
    return { num: d.getDate(), name: d.toLocaleDateString(undefined, { weekday: 'short' }), today: i === todayIdx && sameWeek(today, cursor) };
  });

  const url = `/api/schedule?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}`;
  const { data, unauth, mutate } = useApi<ScheduledRow[]>(url);
  const accountsApi = useApi<{ platform: Platform }[]>('/api/accounts');
  const [selected, setSelected] = useState<ScheduledRow | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Quick-compose-from-slot state.
  const [quickSlot, setQuickSlot] = useState<QuickSlot | null>(null);
  const [quickMode, setQuickMode] = useState<QuickMode>('text');
  const [quickPrompt, setQuickPrompt] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickMsg, setQuickMsg] = useState<string | null>(null);
  /** Platforms checked in the modal — defaults to all connected accounts
   *  the first time the modal opens for a given session. */
  const [quickPlatforms, setQuickPlatforms] = useState<Platform[]>([]);
  /** After Generate is clicked we hold 2-3 variants in state and let the
   *  user pick one before scheduling. null = haven't generated yet. */
  const [quickVariants, setQuickVariants] = useState<null | Array<{ label: string; text: string; score?: number; rationale?: string }>>(null);
  const [quickPickedVariant, setQuickPickedVariant] = useState<string | null>(null);
  const [quickPerPlatform, setQuickPerPlatform] = useState<Partial<Record<Platform, string>>>({});

  // When the modal opens, default platforms to whatever's connected.
  React.useEffect(() => {
    if (quickSlot && quickPlatforms.length === 0) {
      const connected = (accountsApi.data ?? []).map((a) => a.platform);
      if (connected.length > 0) setQuickPlatforms(connected.slice(0, 4));
    }
  }, [quickSlot, accountsApi.data, quickPlatforms.length]);

  const slotIsoFor = (slot: QuickSlot): string => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + slot.day);
    d.setHours(7 + slot.hour, 0, 0, 0);
    return d.toISOString();
  };

  /** True when the slot's start time is in the past — the API would reject
   *  with `scheduledAt_in_past`, and the user can't fix that from a modal.
   *  We block the click upstream. */
  const isSlotPast = (slot: QuickSlot): boolean => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + slot.day);
    d.setHours(7 + slot.hour, 0, 0, 0);
    return d.getTime() <= Date.now();
  };

  /** Step 1: turn the prompt into variants. The user then picks which one
   *  to ship — same mental model as the main compose page. */
  const quickGenerateVariants = async () => {
    if (!quickPrompt.trim()) {
      setQuickMsg('Add a prompt first.');
      return;
    }
    if (quickPlatforms.length === 0) {
      setQuickMsg('Pick at least one platform.');
      return;
    }
    setQuickBusy(true);
    setQuickMsg('Generating variants…');
    try {
      const composed = await apiPost<{
        variants: { label: string; text: string; score?: number; rationale?: string }[];
        perPlatform: Partial<Record<Platform, string>>;
      }>('/api/compose/variants', {
        prompt: quickPrompt,
        platforms: quickPlatforms,
        preset: quickMode === 'video' ? 'reel' : 'announcement',
      });
      if (!composed.variants?.length) {
        setQuickMsg('No draft came back. Try a different prompt.');
        return;
      }
      setQuickVariants(composed.variants);
      setQuickPerPlatform(composed.perPlatform ?? {});
      setQuickPickedVariant(composed.variants[0].label);
      setQuickMsg(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setQuickMsg(`Failed: ${msg.slice(0, 120)}`);
    } finally {
      setQuickBusy(false);
    }
  };

  /** Step 2: persist the picked variant + schedule it at the chosen slot. */
  const quickScheduleAt = async (slot: QuickSlot) => {
    if (!quickVariants || !quickPickedVariant) {
      setQuickMsg('Generate and pick a variant first.');
      return;
    }
    if (isSlotPast(slot)) {
      setQuickMsg('That slot has already passed. Pick a future time.');
      return;
    }
    const picked = quickVariants.find((v) => v.label === quickPickedVariant) ?? quickVariants[0];
    setQuickBusy(true);
    setQuickMsg('Scheduling…');
    try {
      const draft = await apiPost<{ id: string }>('/api/drafts', {
        prompt: quickPrompt,
        body: picked.text,
        variants: quickVariants.map((v) => ({ label: v.label, text: v.text, score: v.score, rationale: v.rationale })),
        selectedVariantLabel: picked.label,
        targetPlatforms: quickPlatforms,
        perPlatformText: quickPerPlatform,
        preset: quickMode === 'video' ? 'reel' : 'announcement',
      });
      const whenIso = slotIsoFor(slot);
      await apiPost('/api/schedule', { draftId: draft.id, scheduledAt: whenIso, platforms: quickPlatforms });
      setQuickMsg('Scheduled.');
      await mutate();
      setTimeout(() => {
        setQuickSlot(null);
        setQuickPrompt('');
        setQuickVariants(null);
        setQuickPickedVariant(null);
        setQuickMsg(null);
      }, 700);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setQuickMsg(`Failed: ${msg.slice(0, 120)}`);
    } finally {
      setQuickBusy(false);
    }
  };

  const cancelScheduled = async (id: string) => {
    if (!confirm('Cancel this scheduled post? It will not be published.')) return;
    setSavingId(id);
    try {
      await apiDelete(`/api/schedule/${id}`);
      await mutate();
      setSelected(null);
    } finally {
      setSavingId(null);
    }
  };

  const rescheduleScheduled = async (id: string, whenIso: string) => {
    setSavingId(id);
    try {
      await apiPatch(`/api/schedule/${id}`, { scheduledAt: whenIso });
      await mutate();
    } finally {
      setSavingId(null);
    }
  };

  const events: CalEvent[] = useMemo(() => {
    if (!data) return [];
    return data.map((s) => {
      const d = new Date(s.scheduledAt);
      const dayIdx = Math.floor((d.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
      const start = Math.max(0, Math.min(13, d.getHours() - 7));
      const type: CalEvent['type'] =
        s.status === 'published' ? 'posted' :
        s.status === 'pending' || s.status === 'publishing' ? 'scheduled' :
        'draft';
      return {
        id: s.id,
        day: dayIdx,
        start,
        span: 1,
        type,
        plats: [PLATFORM_TO_SHORT[s.platform]],
        title: s.text.slice(0, 60),
        time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
      };
    }).filter((e) => e.day >= 0 && e.day < 7);
  }, [data, weekStart]);

  // Demo events ONLY for unauthenticated visitors landing on the page.
  // Signed-in users with an empty schedule see a clean empty state.
  const showDemo = unauth;
  const demoEvents: CalEvent[] = showDemo ? [
    { id: 'd1', day: Math.max(0, todayIdx - 1), start: 2, span: 1, type: 'posted', plats: ['x'], title: 'AI is eating SEO — but slowly', time: '9:15' },
    { id: 'd2', day: todayIdx, start: 5, span: 1, type: 'scheduled', plats: ['li'], title: 'Newsletter recap: indie growth', time: '12:00' },
    { id: 'd3', day: Math.min(6, todayIdx + 1), start: 7, span: 1, type: 'scheduled', plats: ['x', 'li'], title: 'How we ship features without standups', time: '14:00' },
  ] : [];

  const all = events.concat(demoEvents);
  const counts = {
    posted: all.filter((e) => e.type === 'posted').length,
    scheduled: all.filter((e) => e.type === 'scheduled').length,
    ai: all.filter((e) => e.type === 'ai').length,
    draft: all.filter((e) => e.type === 'draft').length,
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button className="btn sm" onClick={() => { const c = new Date(cursor); c.setDate(c.getDate() - 7); setCursor(c); }}>
          <Icon name="chevron_left" size={12} />
        </button>
        <div className="mono" style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.01em', minWidth: 200 }}>
          {fmtRange(cursor)}
        </div>
        <button className="btn sm" onClick={() => { const c = new Date(cursor); c.setDate(c.getDate() + 7); setCursor(c); }}>
          <Icon name="chevron_right" size={12} />
        </button>
        <button className="btn sm" onClick={() => setCursor(startOfWeek(new Date()))}>Today</button>
        <div style={{ flex: 1 }} />
        <div className="mode-switch" style={{ padding: 2 }}>
          <span
            className={`opt ${view === 'week' ? 'active' : ''}`}
            style={{ fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}
            onClick={() => setView('week')}
          >
            Week
          </span>
          <span
            className="opt"
            style={{ fontSize: 11, padding: '3px 10px', cursor: 'not-allowed', opacity: 0.5 }}
            title="Month view coming soon"
          >
            Month
          </span>
          <span
            className={`opt ${view === 'list' ? 'active' : ''}`}
            style={{ fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}
            onClick={() => setView('list')}
          >
            List
          </span>
        </div>
        <button
          className="btn sm primary"
          onClick={() => {
            if (onCompose) onCompose();
            else window.location.href = '/dashboard?tab=compose';
          }}
        >
          <Icon name="plus" size={11} /> New post
        </button>
      </div>

      {unauth && (
        <div style={{ padding: 12, background: 'rgba(124,77,255,0.05)', border: '1px solid rgba(124,77,255,0.2)', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>
          Demo calendar — <a href="/sign-in?next=/dashboard" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>sign in</a> to see your real schedule.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="chip"><span className="dot" style={{ background: 'oklch(0.42 0.16 155)' }} />Posted ({counts.posted})</span>
        <span className="chip"><span className="dot" style={{ background: 'var(--ink)' }} />Scheduled ({counts.scheduled})</span>
        <span className="chip accent"><span className="dot" />Agent draft ({counts.ai})</span>
        <span className="chip"><span className="dot" style={{ background: 'var(--ink-4)' }} />Drafts ({counts.draft})</span>
      </div>

      {view === 'list' ? (
        <CalendarListView events={all} weekStart={weekStart} data={data ?? null} onSelect={setSelected} />
      ) : (
      <div className="calendar">
        <div className="cal-head">
          <div
            className="cell mono"
            style={{ fontSize: 11, padding: '14px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}
            title={Intl.DateTimeFormat().resolvedOptions().timeZone}
          >
            {shortTzLabel()}
          </div>
          {days.map((d, i) => (
            <div key={i} className={`cell ${d.today ? 'today' : ''}`}>
              <div>{d.name}</div>
              <span className="day">{d.num}</span>
            </div>
          ))}
        </div>
        <div className="cal-grid">
          <div className="cal-hour-col">
            {HOURS.map((h) => <div key={h} className="cal-hour-cell">{h}</div>)}
          </div>
          {days.map((_, dayIdx) => (
            <div key={dayIdx} className="cal-day-col">
              {HOURS.map((_, hi) => {
                const past = isSlotPast({ day: dayIdx, hour: hi });
                const clickable = !unauth && !past;
                return (
                  <div
                    key={hi}
                    className="cal-slot"
                    onClick={() => { if (clickable) { setQuickSlot({ day: dayIdx, hour: hi }); setQuickMsg(null); } }}
                    style={{
                      cursor: clickable ? 'pointer' : 'default',
                      background: past ? 'repeating-linear-gradient(135deg, transparent 0 6px, var(--bg-sunk) 6px 7px)' : undefined,
                      opacity: past ? 0.55 : 1,
                    }}
                    title={past ? 'Past time' : unauth ? '' : 'Click to schedule a post'}
                  />
                );
              })}
              {all.filter((e) => e.day === dayIdx).map((e) => {
                const real = data?.find((s) => s.id === e.id) ?? null;
                return (
                  <div
                    key={e.id}
                    className={`cal-event ${e.type}`}
                    style={{
                      top: e.start * slotH + 2,
                      height: e.span * slotH - 6,
                      cursor: real ? 'pointer' : 'default',
                      opacity: savingId === e.id ? 0.5 : 1,
                    }}
                    onClick={() => real && setSelected(real)}
                  >
                    <div className="ev-time">{e.time}</div>
                    <div className="ev-title">{e.title}</div>
                    <div style={{ display: 'flex', gap: 2, marginTop: 3 }}>
                      {e.plats.map((p) => (
                        <span key={p} className={`pglyph ${p}`} style={{ width: 12, height: 12, fontSize: 8, borderRadius: 3 }}>
                          {platGlyphs[p]}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
              {dayIdx === todayIdx && sameWeek(today, weekStart) && <div className="cal-now" style={{ top: nowOffset }} />}
            </div>
          ))}
        </div>
      </div>
      )}

      {quickSlot && (
        <div
          className="modal-scrim"
          onClick={() => { if (!quickBusy) { setQuickSlot(null); setQuickMsg(null); } }}
        >
          <div
            className="modal-sheet"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(560px, 92vw)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <Icon name="sparkle" size={16} style={{ color: 'var(--accent)' }} />
              <h3 style={{ margin: 0, fontSize: 15, letterSpacing: '-0.01em' }}>
                What do you want to post?
              </h3>
              <span className="chip ghost mono" style={{ marginLeft: 'auto' }}>
                {new Date(slotIsoFor(quickSlot)).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
              <button className="icon-btn" onClick={() => { if (!quickBusy) { setQuickSlot(null); setQuickMsg(null); } }}>
                <Icon name="x" size={14} />
              </button>
            </div>

            {/* Mode chips */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {(['text', 'image', 'video'] as QuickMode[]).map((m) => (
                <span
                  key={m}
                  onClick={() => setQuickMode(m)}
                  className={`prompt-chip ${quickMode === m ? 'active' : ''}`}
                  style={{ textTransform: 'capitalize' }}
                >
                  <Icon name={m === 'text' ? 'edit' : m === 'image' ? 'image' : 'play'} size={11} />
                  {m === 'text' ? 'Text' : m === 'image' ? 'Image' : 'Video'} post
                </span>
              ))}
            </div>

            <textarea
              value={quickPrompt}
              onChange={(e) => setQuickPrompt(e.target.value)}
              placeholder="What's this post about? One sentence is enough."
              autoFocus
              style={{
                width: '100%', minHeight: 72, padding: 12, fontSize: 13,
                border: '1px solid var(--line-2)', borderRadius: 10, background: 'var(--bg)',
                color: 'var(--ink)', fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5,
                marginBottom: 10,
              }}
            />

            {/* Platform pills — multi-select. We default to all connected,
                but the user can dial it down to a subset for this one slot. */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Platforms
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(accountsApi.data ?? []).map((acct) => {
                  const p = acct.platform;
                  const on = quickPlatforms.includes(p);
                  return (
                    <span
                      key={p}
                      onClick={() => setQuickPlatforms((cur) => on ? cur.filter((x) => x !== p) : [...cur, p])}
                      className={`prompt-chip ${on ? 'active' : ''}`}
                      style={{ textTransform: 'capitalize' }}
                    >
                      {p}
                    </span>
                  );
                })}
                {(accountsApi.data ?? []).length === 0 && (
                  <span style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>
                    No accounts connected yet.
                  </span>
                )}
              </div>
            </div>

            {/* Variants — only shown after Generate. User picks one. */}
            {quickVariants && quickVariants.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Pick a variant
                  <button
                    className="chip ghost"
                    onClick={quickGenerateVariants}
                    disabled={quickBusy}
                    style={{ marginLeft: 'auto', fontSize: 10 }}
                  >
                    <Icon name="refresh" size={10} /> Regenerate
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                  {quickVariants.map((v) => {
                    const picked = quickPickedVariant === v.label;
                    return (
                      <div
                        key={v.label}
                        onClick={() => setQuickPickedVariant(v.label)}
                        style={{
                          padding: 10, fontSize: 12, lineHeight: 1.4,
                          border: picked ? '2px solid var(--accent)' : '1px solid var(--line-2)',
                          borderRadius: 8, background: picked ? 'var(--accent-soft)' : 'var(--bg)',
                          cursor: 'pointer', position: 'relative',
                          display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}
                      >
                        <div style={{ fontSize: 9.5, fontFamily: 'var(--mono)', color: picked ? 'var(--accent-ink)' : 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                          {v.label}{typeof v.score === 'number' ? ` · ${Math.round(v.score)}` : ''}
                        </div>
                        {v.text}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {quickMsg && (
              <div style={{ padding: 10, fontSize: 12.5, background: 'var(--bg-sunk)', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 12 }}>
                {quickMsg}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <a
                href={`/dashboard?tab=compose&prompt=${encodeURIComponent(quickPrompt)}&slot=${encodeURIComponent(slotIsoFor(quickSlot))}&platforms=${encodeURIComponent(quickPlatforms.join(','))}`}
                className="chip ghost"
                style={{ fontSize: 11 }}
              >
                <Icon name="edit" size={10} /> Edit in compose
              </a>
              <div style={{ flex: 1 }} />
              <button
                className="btn"
                onClick={() => { if (!quickBusy) { setQuickSlot(null); setQuickMsg(null); setQuickVariants(null); setQuickPickedVariant(null); } }}
                disabled={quickBusy}
              >
                Cancel
              </button>
              {!quickVariants ? (
                <button
                  className="btn primary"
                  onClick={quickGenerateVariants}
                  disabled={quickBusy || !quickPrompt.trim() || quickPlatforms.length === 0}
                >
                  {quickBusy
                    ? <><Icon name="refresh" size={12} /> Generating</>
                    : <><Icon name="sparkle" size={12} /> Generate variants</>}
                </button>
              ) : (
                <button
                  className="btn primary"
                  onClick={() => quickScheduleAt(quickSlot)}
                  disabled={quickBusy || !quickPickedVariant}
                >
                  {quickBusy
                    ? <><Icon name="refresh" size={12} /> Scheduling</>
                    : <><Icon name="calendar" size={12} /> Schedule this</>}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {selected && (
        <div
          className="modal-scrim"
          onClick={() => setSelected(null)}
        >
          <div
            className="modal-sheet"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(520px, 90vw)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span className={`pglyph ${PLATFORM_TO_SHORT[selected.platform]}`} style={{ width: 22, height: 22 }}>
                {platGlyphs[PLATFORM_TO_SHORT[selected.platform]]}
              </span>
              <h3 style={{ margin: 0, fontSize: 16, letterSpacing: '-0.01em' }}>
                {selected.platform} · {new Date(selected.scheduledAt).toLocaleString()}
              </h3>
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', padding: 14, background: 'var(--bg-sunk)', borderRadius: 10, marginBottom: 14, color: 'var(--ink-2)' }}>
              {selected.text}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>Reschedule</label>
              <input
                type="datetime-local"
                defaultValue={toLocalInputValue(selected.scheduledAt)}
                onChange={(e) => {
                  const v = new Date(e.target.value);
                  if (!Number.isNaN(v.getTime())) rescheduleScheduled(selected.id, v.toISOString());
                }}
                style={{ padding: '6px 8px', border: '1px solid var(--line-2)', borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 12 }}
              />
              <div style={{ flex: 1 }} />
              {selected.platformPostUrl && (
                <a className="btn sm ghost" href={selected.platformPostUrl} target="_blank" rel="noreferrer">
                  <Icon name="arrow_right" size={11} /> View
                </a>
              )}
              <button className="btn sm" onClick={() => cancelScheduled(selected.id)} disabled={savingId === selected.id}>
                <Icon name="x" size={11} /> Cancel post
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

interface CalendarListViewProps {
  events: CalEvent[];
  weekStart: Date;
  data: ScheduledRow[] | null;
  onSelect: (row: ScheduledRow) => void;
}

const CalendarListView: React.FC<CalendarListViewProps> = ({ events, weekStart, data, onSelect }) => {
  const byDay = new Map<number, CalEvent[]>();
  for (const e of events) {
    const list = byDay.get(e.day) ?? [];
    list.push(e);
    byDay.set(e.day, list);
  }
  const days = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return { idx: i, date: d, label: d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) };
  });

  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {days.map((d) => {
          const list = (byDay.get(d.idx) ?? []).slice().sort((a, b) => a.start - b.start);
          return (
            <div key={d.idx} style={{ borderBottom: '1px solid var(--line)' }}>
              <div className="mono" style={{ padding: '10px 16px', fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'var(--bg-sunk)' }}>
                {d.label}
              </div>
              {list.length === 0 ? (
                <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--ink-4)' }}>Nothing scheduled.</div>
              ) : (
                list.map((e) => {
                  const real = data?.find((s) => s.id === e.id) ?? null;
                  return (
                    <div
                      key={e.id}
                      onClick={() => real && onSelect(real)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '64px 1fr auto',
                        gap: 12,
                        padding: '10px 16px',
                        cursor: real ? 'pointer' : 'default',
                        alignItems: 'center',
                        borderTop: '1px solid var(--line)',
                      }}
                    >
                      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{e.time}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center' }}>
                          {e.plats.map((p) => (
                            <span key={p} className={`pglyph ${p}`} style={{ width: 14, height: 14, fontSize: 9, borderRadius: 3 }}>
                              {platGlyphs[p]}
                            </span>
                          ))}
                          <span className={`chip ${e.type === 'ai' ? 'accent' : ''}`} style={{ fontSize: 10 }}>
                            {e.type === 'posted' ? 'Posted' : e.type === 'scheduled' ? 'Scheduled' : e.type === 'ai' ? 'Agent draft' : 'Draft'}
                          </span>
                        </div>
                      </div>
                      {real && <Icon name="arrow_right" size={12} style={{ color: 'var(--ink-3)' }} />}
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sameWeek(a: Date, weekStart: Date) {
  const ws = startOfWeek(a).getTime();
  return ws === weekStart.getTime();
}

export default CalendarPage;
