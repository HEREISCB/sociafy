'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { addDays, differenceInCalendarDays, format, isSameDay, setHours, startOfDay } from 'date-fns';
import { Glyphs } from './glyphs';
import { firstLine, type PostGroup, type ReviewItem } from './model';
import { statusLabel } from './panel';

const SLOT_H = 48;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

type Placed = { key: string; day: number; at: Date; node: (style: React.CSSProperties) => React.ReactNode };

/** Week grid: 24 scrollable hours, opened at 7 AM. Posts sit at their real
 *  time; a draft's platforms share one block; same-hour posts split the column. */
export function WeekGrid({ weekStart, groups, review, now, onSelect }: {
  weekStart: Date;
  groups: PostGroup[];
  review: ReviewItem[];
  now: number;
  onSelect: (g: PostGroup) => void;
}) {
  const router = useRouter();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * SLOT_H; }, []);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const placed = useMemo(() => {
    const items: Placed[] = [
      ...groups.map((g): Placed => ({
        key: g.key,
        day: differenceInCalendarDays(g.at, weekStart),
        at: g.at,
        node: (style) => (
          <button type="button" key={g.key} style={style} className={`cal-ev cal-ev--${g.accountGone ? 'failed' : g.status}`} onClick={() => onSelect(g)}>
            <span className="cal-ev__time">{format(g.at, 'p')}{g.accountGone ? ' · Account disconnected' : g.status !== 'pending' && ` · ${statusLabel(g)}`}</span>
            <span className="cal-ev__title">{firstLine(g.text)}</span>
            <Glyphs platforms={g.platforms} />
          </button>
        ),
      })),
      ...review.flatMap((r): Placed[] => {
        if (!r.plannedAt) return [];
        const at = new Date(r.plannedAt);
        return [{
          key: `r${r.id}`,
          day: differenceInCalendarDays(at, weekStart),
          at,
          node: (style) => (
            <Link key={`r${r.id}`} href="/dashboard" style={style} className="cal-ev cal-ev--review">
              <span className="cal-ev__time">{format(at, 'p')} · Needs review</span>
              <span className="cal-ev__title">{r.title || firstLine(r.body)}</span>
            </Link>
          ),
        }];
      }),
    ].filter((p) => p.day >= 0 && p.day < 7);
    // Same day + hour → side by side.
    const buckets = new Map<string, Placed[]>();
    for (const p of items) {
      const k = `${p.day}|${p.at.getHours()}`;
      buckets.set(k, [...(buckets.get(k) ?? []), p]);
    }
    return items.map((p) => {
      const bucket = buckets.get(`${p.day}|${p.at.getHours()}`)!;
      const i = bucket.indexOf(p);
      const w = 100 / bucket.length;
      return {
        day: p.day,
        el: p.node({
          top: (p.at.getHours() + p.at.getMinutes() / 60) * SLOT_H + 2,
          left: `calc(${i * w}% + 2px)`,
          width: `calc(${w}% - 4px)`,
        }),
      };
    });
  }, [groups, review, weekStart, onSelect]);

  const today = now ? new Date(now) : null;
  const nowTop = today ? (today.getHours() + today.getMinutes() / 60) * SLOT_H : 0;

  return (
    <div className="calendar">
      <div className="cal-head">
        <div className="cell cal-tz">{format(weekStart, 'O')}</div>
        {days.map((d) => (
          <div key={d.toISOString()} className={`cell${today && isSameDay(d, today) ? ' today' : ''}`}>
            {format(d, 'EEE')}
            <span className="day">{format(d, 'd')}</span>
          </div>
        ))}
      </div>
      <div className="cal-grid" ref={scroller}>
        <div className="cal-hour-col">
          {HOURS.map((h) => <div key={h} className="cal-hour-cell">{format(setHours(startOfDay(weekStart), h), 'h a')}</div>)}
        </div>
        {days.map((d, dayIdx) => (
          <div key={dayIdx} className="cal-day-col">
            {HOURS.map((h) => {
              const slot = setHours(startOfDay(d), h);
              const past = !now || slot.getTime() <= now;
              return (
                <button
                  type="button"
                  key={h}
                  className="cal-slot"
                  disabled={past}
                  onClick={() => router.push(`/compose?slot=${encodeURIComponent(slot.toISOString())}`)}
                  aria-label={past ? undefined : `New post ${format(slot, 'EEE p')}`}
                />
              );
            })}
            {placed.filter((p) => p.day === dayIdx).map((p) => p.el)}
            {today && isSameDay(d, today) && <div className="cal-now" style={{ top: nowTop }} />}
          </div>
        ))}
      </div>
    </div>
  );
}
