'use client';

import React from 'react';
import { Icon } from '../icons';
import type { PostKind } from '../../lib/platforms/capabilities';
import { dayIndex, weekDays } from '../../lib/agent/week';

/**
 * proj     — where a post would land (dashed); nothing exists yet
 * drafting — the slot is reserved and the post is being written (washed, pulsing)
 * ready    — a real draft or queued post; it "develops" in when it first appears
 */
export type StripSlot = { key: string; at: string; kind: PostKind; state: 'proj' | 'drafting' | 'ready'; title?: string | null; thumb?: string | null;
  /** Was already there when the page loaded: shown sharp, without developing. */
  still?: boolean };

const KIND: Record<PostKind, { icon: 'list' | 'image' | 'play'; label: string }> = {
  text: { icon: 'list', label: 'Text' },
  image: { icon: 'image', label: 'Image' },
  video: { icon: 'play', label: 'Video' },
};

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Thu 22 – Wed 28 Oct" */
export const weekRange = (from: Date) => {
  const days = weekDays(from);
  const day = (d: Date) => `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`;
  return `${day(days[0])} – ${day(days[6])} ${days[6].toLocaleDateString(undefined, { month: 'short' })}`;
};

export default function WeekStrip({ from, slots, readyLabel = 'Ready' }: { from: Date; slots: StripSlot[]; readyLabel?: string }) {
  const days = weekDays(from);
  const byDay = days.map(() => [] as StripSlot[]);
  for (const s of slots) byDay[dayIndex(new Date(s.at), days)].push(s);
  return (
    <div className="ap-week-box">
      <div className="ap-week">
        {days.map((d, i) => (
          <div className="ap-day" key={d.toISOString()}>
            <div className="ap-day-h">
              {d.toLocaleDateString(undefined, { weekday: 'short' })}
              <b>{d.getDate()}</b>
            </div>
            {byDay[i].map((s) => {
              const at = new Date(s.at);
              const k = KIND[s.kind];
              return (
                <div key={s.key} className={`ap-slot is-${s.state}${s.state === 'ready' && !s.still ? ' develop' : ''}`} title={`${k.label} post · ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time(at)}${s.title ? ` · ${s.title}` : ''}`}>
                  <span className="ap-slot-k"><Icon name={k.icon} size={12} /><span>{k.label}</span></span>
                  <span className="ap-slot-t">{time(at)}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element -- tiny thumb from our own bucket */}
                  {s.state === 'ready' && s.thumb && <img className="ap-slot-img" src={s.thumb} alt="" loading="lazy" />}
                  {s.state === 'ready' && s.title && <span className="ap-slot-ttl">{s.title}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="ap-legend" aria-hidden="true">
        <span><i className="is-proj" />Projected</span>
        <span><i className="is-drafting" />Drafting</span>
        <span><i className="is-ready" />{readyLabel}</span>
      </div>
    </div>
  );
}
