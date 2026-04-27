'use client';

import React from 'react';
import { Icon, Pglyph } from './icons';

const HOURS = ['7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM'];
const DAYS_OF_WEEK = [
  { num: 21, name: 'Mon' },
  { num: 22, name: 'Tue' },
  { num: 23, name: 'Wed' },
  { num: 24, name: 'Thu' },
  { num: 25, name: 'Fri' },
  { num: 26, name: 'Sat' },
  { num: 27, name: 'Sun', today: true },
];

type EventType = 'posted' | 'scheduled' | 'ai' | 'draft';

interface CalEvent {
  day: number;
  start: number;
  span: number;
  type: EventType;
  plats: string[];
  title: string;
  time: string;
}

const EVENTS: CalEvent[] = [
  { day: 0, start: 2, span: 1, type: 'posted', plats: ['x'], title: 'AI is eating SEO — but slowly', time: '9:15 AM' },
  { day: 0, start: 5, span: 1, type: 'posted', plats: ['li'], title: 'Newsletter recap: indie growth', time: '12:00 PM' },
  { day: 1, start: 1, span: 1, type: 'scheduled', plats: ['x', 'li'], title: 'How we ship features without standups', time: '8:00 AM' },
  { day: 1, start: 7, span: 1, type: 'ai', plats: ['ig'], title: 'Studio tour — natural light setup', time: '2:00 PM' },
  { day: 2, start: 2, span: 1, type: 'scheduled', plats: ['li'], title: '5 small studios past $1M ARR', time: '9:00 AM' },
  { day: 2, start: 11, span: 1, type: 'draft', plats: ['x'], title: 'Hot take draft', time: '6:00 PM' },
  { day: 3, start: 3, span: 1, type: 'ai', plats: ['ig', 'tt'], title: 'Reel: agent walks you through your queue', time: '10:00 AM' },
  { day: 3, start: 8, span: 1, type: 'scheduled', plats: ['x', 'fb'], title: 'Founder lessons #12', time: '3:00 PM' },
  { day: 4, start: 5, span: 1, type: 'ai', plats: ['li'], title: 'Voice posts coming soon — preview', time: '12:00 PM' },
  { day: 5, start: 4, span: 1, type: 'draft', plats: ['ig'], title: 'Weekend behind the scenes', time: '11:00 AM' },
  { day: 6, start: 7, span: 1, type: 'scheduled', plats: ['x', 'li'], title: '3 metrics every solo founder should ignore', time: '2:30 PM' },
  { day: 6, start: 11, span: 1, type: 'ai', plats: ['ig', 'fb'], title: 'Behind the scenes — new studio setup', time: '6:00 PM' },
];

const platGlyphs: Record<string, string> = { ig: 'I', fb: 'f', x: 'X', li: 'in', tt: 'T', yt: 'Y' };

const CalendarPage: React.FC = () => {
  const slotH = 48;
  const todayIdx = 6;
  const nowOffset = 9.4 * slotH;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button className="btn sm"><Icon name="chevron_left" size={12} /></button>
        <div className="mono" style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-0.01em', minWidth: 180 }}>
          April 21 – 27, 2026
        </div>
        <button className="btn sm"><Icon name="chevron_right" size={12} /></button>
        <button className="btn sm">Today</button>
        <div style={{ flex: 1 }} />
        <div className="mode-switch" style={{ padding: 2 }}>
          <span className="opt active" style={{ fontSize: 11, padding: '3px 10px' }}>Week</span>
          <span className="opt" style={{ fontSize: 11, padding: '3px 10px' }}>Month</span>
          <span className="opt" style={{ fontSize: 11, padding: '3px 10px' }}>List</span>
        </div>
        <button className="btn sm"><Icon name="filter" size={11} /> Filters</button>
        <button className="btn sm primary"><Icon name="plus" size={11} /> New post</button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="chip"><span className="dot" style={{ background: 'oklch(0.42 0.16 155)' }} />Posted (12)</span>
        <span className="chip"><span className="dot" style={{ background: 'var(--ink)' }} />Scheduled (8)</span>
        <span className="chip accent"><span className="dot" />Agent draft (4)</span>
        <span className="chip"><span className="dot" style={{ background: 'var(--ink-4)' }} />Drafts (3)</span>
        <div style={{ flex: 1 }} />
        <span className="chip ghost mono">14 of 20 weekly slots filled</span>
      </div>

      <div className="calendar">
        <div className="cal-head">
          <div className="cell mono" style={{ fontSize: 10, padding: '14px 8px' }}>GMT-5</div>
          {DAYS_OF_WEEK.map((d, i) => (
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
          {DAYS_OF_WEEK.map((_, dayIdx) => (
            <div key={dayIdx} className="cal-day-col">
              {HOURS.map((_, hi) => <div key={hi} className="cal-slot" />)}
              {EVENTS.filter((e) => e.day === dayIdx).map((e, i) => (
                <div
                  key={i}
                  className={`cal-event ${e.type}`}
                  style={{ top: e.start * slotH + 2, height: e.span * slotH - 6 }}
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
              ))}
              {dayIdx === todayIdx && <div className="cal-now" style={{ top: nowOffset }} />}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

export default CalendarPage;
