'use client';

import React, { useMemo, useState } from 'react';
import { Icon } from './icons';
import { apiDelete, apiPatch, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../lib/ui/platforms';
import type { Platform } from '../lib/db/schema';

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

const CalendarPage: React.FC = () => {
  const slotH = 48;
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
  const [selected, setSelected] = useState<ScheduledRow | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

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

  const showDemo = !data || events.length === 0;
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
          <span className="opt active" style={{ fontSize: 11, padding: '3px 10px' }}>Week</span>
          <span className="opt" style={{ fontSize: 11, padding: '3px 10px' }}>Month</span>
          <span className="opt" style={{ fontSize: 11, padding: '3px 10px' }}>List</span>
        </div>
        <button className="btn sm primary"><Icon name="plus" size={11} /> New post</button>
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

      <div className="calendar">
        <div className="cal-head">
          <div className="cell mono" style={{ fontSize: 10, padding: '14px 8px' }}>{Intl.DateTimeFormat().resolvedOptions().timeZone}</div>
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
              {HOURS.map((_, hi) => <div key={hi} className="cal-slot" />)}
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

      {selected && (
        <div
          onClick={() => setSelected(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.4)',
            display: 'grid', placeItems: 'center', zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-elev)', border: '1px solid var(--line)',
              borderRadius: 16, padding: 24, width: 'min(520px, 90vw)',
              boxShadow: '0 24px 60px -24px rgba(0,0,0,0.3)',
            }}
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
