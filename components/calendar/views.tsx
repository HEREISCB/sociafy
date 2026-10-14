'use client';

import React from 'react';
import Link from 'next/link';
import { addDays, addHours, format, isSameMonth, startOfDay, startOfHour } from 'date-fns';
import { Icon } from '../icons';
import { Glyphs } from './glyphs';
import { dayKey, isVideo, itemMedia, itemPlatforms, itemTitle, movable, statusLabel, toneOf, type CalItem, type Tone } from './model';

const BADGE: Partial<Record<Tone, string>> = { review: 'Review', waiting: 'Rendering', publishing: 'Posting', failed: 'Failed', canceled: 'Canceled' };
const badgeFor = (i: CalItem) => {
  const t = toneOf(i);
  if (i.kind === 'post' && i.group.accountGone) return 'Reconnect';
  if (t === 'canceled' && i.kind === 'post') return statusLabel(i.group);
  return BADGE[t];
};

/** Media preview: image, a video's first frame, or a "Text" tile. */
export function Thumb({ item, controls }: { item: CalItem; controls?: boolean }) {
  const m = itemMedia(item);
  const rendering = item.kind === 'draft' && item.draft.rendering;
  return (
    <span className="hc-thumb" aria-hidden={!controls}>
      {rendering && !m ? (
        <span className="hc-thumb__ph">Rendering…</span>
      ) : !m ? (
        <span className="hc-thumb__ph">Text</span>
      ) : isVideo(m) ? (
        <>
          <video src={`${m.url}#t=0.1`} preload="metadata" muted playsInline controls={controls} />
          {!controls && <span className="hc-thumb__play"><Icon name="play" size={10} /></span>}
        </>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.url} alt="" loading="lazy" />
      )}
    </span>
  );
}

type Open = (i: CalItem) => void;
type Move = (key: string, day: Date) => void;

export function dragProps(i: CalItem) {
  return movable(i)
    ? { draggable: true, onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/x-cal', i.key); e.dataTransfer.effectAllowed = 'move'; } }
    : {};
}

/** Week card: thumbnail, time + platforms, title, status. */
export function Card({ item, onOpen }: { item: CalItem; onOpen: Open }) {
  const badge = badgeFor(item);
  const tone = toneOf(item);
  return (
    <button type="button" className={`hc hc--${tone}`} onClick={() => onOpen(item)} {...dragProps(item)}>
      <Thumb item={item} />
      {badge && <span className={`hc__badge hc__badge--${tone}`}>{badge}</span>}
      <span className="hc__meta">
        <span className="tnum">{item.at ? format(item.at, 'h:mm a') : 'No time'}</span>
        {tone === 'published' && <Icon name="check" size={11} aria-label="Posted" />}
        <Glyphs platforms={itemPlatforms(item)} />
      </span>
      <span className="hc__title">{itemTitle(item)}</span>
    </button>
  );
}

/** Where "+" on a day starts a post: 10 AM, or the next hour if that passed. */
function slotFor(day: Date, now: number) {
  const ten = addHours(startOfDay(day), 10);
  return ten.getTime() > now ? ten : startOfHour(addHours(new Date(now), 1));
}

function useDrop(day: Date, now: number, onMove: Move) {
  const open = now > 0 && addDays(startOfDay(day), 1).getTime() > now;
  const [over, setOver] = React.useState(false);
  if (!open) return { over: false, props: {} };
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('text/x-cal')) { e.preventDefault(); setOver(true); } },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(false); const k = e.dataTransfer.getData('text/x-cal'); if (k) onMove(k, day); },
    },
  };
}

function AddLink({ day, now, label }: { day: Date; now: number; label?: boolean }) {
  if (!now || addDays(startOfDay(day), 1).getTime() <= now) return null;
  const slot = slotFor(day, now);
  return (
    <Link className="hc-add" href={`/compose?slot=${encodeURIComponent(slot.toISOString())}`} aria-label={`New post ${format(day, 'EEE d MMM')}`}>
      <Icon name="plus" size={12} />{label && <span>New post</span>}
    </Link>
  );
}

export function WeekView({ start, days: map, now, onOpen, onMove }: { start: Date; days: Map<string, CalItem[]>; now: number; onOpen: Open; onMove: Move }) {
  return (
    <div className="hw" role="grid" aria-label={`Week of ${format(start, 'd MMM')}`}>
      {Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d) => (
        <WeekDay key={d.toISOString()} day={d} items={map.get(dayKey(d)) ?? []} now={now} onOpen={onOpen} onMove={onMove} />
      ))}
    </div>
  );
}

function WeekDay({ day, items, now, onOpen, onMove }: { day: Date; items: CalItem[]; now: number; onOpen: Open; onMove: Move }) {
  const today = now > 0 && dayKey(day) === dayKey(new Date(now));
  const past = now > 0 && addDays(startOfDay(day), 1).getTime() <= now;
  const drop = useDrop(day, now, onMove);
  return (
    <section role="gridcell" className={`hw__day${today ? ' is-today' : ''}${past ? ' is-past' : ''}${drop.over ? ' is-over' : ''}`} {...drop.props}>
      <header className="hw__head">
        <span>{format(day, 'EEE')}</span>
        <span className="hw__date tnum">{format(day, 'd')}</span>
      </header>
      <div className="hw__items">
        {items.map((i) => <Card key={i.key} item={i} onOpen={onOpen} />)}
        <AddLink day={day} now={now} label={items.length === 0} />
      </div>
    </section>
  );
}

const MAX_CHIPS = 3;

export function MonthView({ month, days: map, now, onOpen, onMove, onMore }: {
  month: Date; days: Map<string, CalItem[]>; now: number; onOpen: Open; onMove: Move; onMore: (day: Date) => void;
}) {
  const first = addDays(month, -((month.getDay() + 6) % 7)); // Monday on/before the 1st
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  return (
    <div className="hm" role="grid" aria-label={format(month, 'MMMM yyyy')}>
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="hm__dow">{d}</div>)}
      {cells.map((d) => (
        <MonthDay key={d.toISOString()} day={d} out={!isSameMonth(d, month)} items={map.get(dayKey(d)) ?? []} now={now} onOpen={onOpen} onMove={onMove} onMore={onMore} />
      ))}
    </div>
  );
}

function MonthDay({ day, out, items, now, onOpen, onMove, onMore }: {
  day: Date; out: boolean; items: CalItem[]; now: number; onOpen: Open; onMove: Move; onMore: (d: Date) => void;
}) {
  const today = now > 0 && dayKey(day) === dayKey(new Date(now));
  const drop = useDrop(day, now, onMove);
  const extra = items.length - MAX_CHIPS;
  return (
    <div role="gridcell" className={`hm__day${out ? ' is-out' : ''}${today ? ' is-today' : ''}${drop.over ? ' is-over' : ''}`} {...drop.props}>
      <div className="hm__top">
        <span className="hm__date tnum">{format(day, 'd')}</span>
        {items.length === 0 && <AddLink day={day} now={now} />}
      </div>
      {items.slice(0, extra > 0 ? MAX_CHIPS - 1 : MAX_CHIPS).map((i) => (
        <button key={i.key} type="button" className={`hm-chip hm-chip--${toneOf(i)}`} onClick={() => onOpen(i)} {...dragProps(i)}>
          <span className="tnum">{i.at && format(i.at, 'h:mma').toLowerCase()}</span>
          <span className="hm-chip__title">{itemTitle(i)}</span>
        </button>
      ))}
      {extra > 0 && <button type="button" className="hm-more" onClick={() => onMore(day)}>+{extra + 1} more</button>}
    </div>
  );
}

/** Phones: the period's days that have posts, as a list. */
export function AgendaView({ start, length, days: map, now, onOpen }: { start: Date; length: number; days: Map<string, CalItem[]>; now: number; onOpen: Open }) {
  const days = Array.from({ length }, (_, i) => addDays(start, i)).filter((d) => map.has(dayKey(d)));
  if (!days.length) return <p className="ha__empty">Nothing on the calendar for this period.</p>;
  const todayKey = now ? dayKey(new Date(now)) : '';
  return (
    <div className="ha">
      {days.map((d) => (
        <section key={d.toISOString()}>
          <h2 className={`ha__day${dayKey(d) === todayKey ? ' is-today' : ''}`}>{dayKey(d) === todayKey ? 'Today' : format(d, 'EEEE d MMM')}</h2>
          <ul className="ha__list">
            {map.get(dayKey(d))!.map((i) => {
              const badge = badgeFor(i);
              const tone = toneOf(i);
              return (
                <li key={i.key}>
                  <button type="button" className={`ha-row hc--${tone}`} onClick={() => onOpen(i)}>
                    <Thumb item={i} />
                    <span className="ha-row__main">
                      <span className="hc__title">{itemTitle(i)}</span>
                      <span className="hc__meta">
                        <span className="tnum">{i.at && format(i.at, 'h:mm a')}</span>
                        <Glyphs platforms={itemPlatforms(i)} />
                        {badge && <span className={`hc__badge hc__badge--${tone} is-inline`}>{badge}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
