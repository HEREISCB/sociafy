'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSWRConfig } from 'swr';
import { addDays, addWeeks, format, isToday, isTomorrow, startOfDay, startOfWeek, subDays } from 'date-fns';
import { Icon } from '../icons';
import { useApi } from '../../lib/ui/fetcher';
import { Glyphs } from './glyphs';
import { firstLine, groupRows, needsAttention, type PostGroup, type ReviewItem, type ScheduledRow } from './model';
import { PostPanel, statusLabel } from './panel';
import { WeekGrid } from './week';

/** Ticking "now" in epoch ms; 0 until mounted so server and client first paints agree. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const weekOf = (d: Date) => startOfWeek(d, { weekStartsOn: 1 });

export default function Calendar() {
  const [view, setView] = useState<'list' | 'week'>('list');
  const [weekStart, setWeekStart] = useState(() => weekOf(new Date()));
  const [range] = useState(() => {
    const today = startOfDay(new Date());
    return { from: subDays(today, 14).toISOString(), to: addDays(today, 90).toISOString() };
  });
  const now = useNow(60_000);

  const listApi = useApi<ScheduledRow[]>(`/api/schedule?from=${range.from}&to=${range.to}`);
  const weekApi = useApi<ScheduledRow[]>(
    view === 'week' ? `/api/schedule?from=${weekStart.toISOString()}&to=${addWeeks(weekStart, 1).toISOString()}` : null,
  );
  const planApi = useApi<{ review: ReviewItem[] }>('/api/plan');
  const review = planApi.data?.review ?? [];

  const { mutate } = useSWRConfig();
  const refresh = useCallback(() => {
    mutate((k) => typeof k === 'string' && k.startsWith('/api/schedule'));
  }, [mutate]);

  const [selected, setSelected] = useState<PostGroup | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const listGroups = useMemo(() => groupRows(listApi.data ?? []), [listApi.data]);
  const weekGroups = useMemo(() => groupRows(weekApi.data ?? []), [weekApi.data]);

  return (
    <>
      <div className="cal-toolbar">
        <div className="mode-switch" aria-label="View">
          {(['list', 'week'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} className={`opt${view === v ? ' active' : ''}`} onClick={() => setView(v)}>
              {v === 'list' ? 'List' : 'Week'}
            </button>
          ))}
        </div>
        {view === 'week' && (
          <div className="row">
            <button type="button" className="btn sm ghost" aria-label="Previous week" onClick={() => setWeekStart((w) => addWeeks(w, -1))}>
              <Icon name="chevron_left" size={12} />
            </button>
            <span className="cal-range">{format(weekStart, 'MMM d')} – {format(addDays(weekStart, 6), 'MMM d, yyyy')}</span>
            <button type="button" className="btn sm ghost" aria-label="Next week" onClick={() => setWeekStart((w) => addWeeks(w, 1))}>
              <Icon name="chevron_right" size={12} />
            </button>
            <button type="button" className="btn sm" onClick={() => setWeekStart(weekOf(new Date()))}>Today</button>
          </div>
        )}
      </div>

      <p className="cal-notice" role="status">{notice}</p>

      {listApi.unauth ? (
        <div className="empty-state">
          <h3>Sign in to see your calendar</h3>
          <Link className="btn" href="/sign-in?next=/calendar">Sign in</Link>
        </div>
      ) : listApi.error ? (
        <div className="empty-state">
          <h3>Couldn&apos;t load your schedule</h3>
          <button type="button" className="btn" onClick={refresh}>Try again</button>
        </div>
      ) : view === 'list' ? (
        <ListView groups={listGroups} review={review} now={now} loading={listApi.isLoading} onSelect={setSelected} />
      ) : (
        <WeekGrid weekStart={weekStart} groups={weekGroups} review={review} now={now} onSelect={setSelected} />
      )}

      {selected && (
        <PostPanel
          key={selected.key}
          group={selected}
          onClose={() => setSelected(null)}
          refresh={refresh}
          onDone={(msg) => { setSelected(null); setNotice(msg); refresh(); }}
        />
      )}
    </>
  );
}

function ListView({ groups, review, now, loading, onSelect }: {
  groups: PostGroup[];
  review: ReviewItem[];
  now: number;
  loading: boolean;
  onSelect: (g: PostGroup) => void;
}) {
  if (loading) return <p className="cal-muted">Loading…</p>;

  const attention = groups.filter(needsAttention);
  const upcoming = groups.filter((g) => !needsAttention(g) && (
    g.status === 'pending' || g.status === 'publishing' || (g.status === 'canceled' && g.at.getTime() > now)
  ));
  const posted = groups.filter((g) => g.status === 'published').reverse().slice(0, 10);
  const planned = review.filter((r) => r.plannedAt);
  const overdue = planned.filter((r) => r.overdue);

  type Item = { at: Date; node: React.ReactNode };
  const upcomingItems: Item[] = [
    ...upcoming.map((g) => ({ at: g.at, node: <PostRow key={g.key} g={g} onSelect={onSelect} /> })),
    ...planned.filter((r) => !r.overdue).map((r) => ({ at: new Date(r.plannedAt!), node: <ReviewRow key={r.id} r={r} /> })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const byDay = new Map<string, Item[]>();
  for (const it of upcomingItems) {
    const k = format(it.at, 'yyyy-MM-dd');
    byDay.set(k, [...(byDay.get(k) ?? []), it]);
  }

  if (attention.length + overdue.length + upcomingItems.length + posted.length === 0) {
    return (
      <div className="empty-state">
        <h3>Nothing scheduled</h3>
        <p>Plan the coming week and approved posts will show up here.</p>
        <Link className="btn" href="/dashboard">Plan posts</Link>
      </div>
    );
  }

  return (
    <div className="cal-list">
      {attention.length + overdue.length > 0 && (
        <section>
          <h2 className="cal-section">Needs attention</h2>
          <ul className="cal-rows">
            {attention.map((g) => <PostRow key={g.key} g={g} onSelect={onSelect} showDate />)}
            {overdue.map((r) => <ReviewRow key={r.id} r={r} showDate />)}
          </ul>
        </section>
      )}
      <section>
        <h2 className="cal-section">Upcoming</h2>
        {byDay.size === 0 ? (
          <p className="cal-muted">Nothing queued. <Link href="/dashboard">Plan posts</Link></p>
        ) : (
          [...byDay.entries()].map(([k, items]) => (
            <div key={k} className="cal-day">
              <h3 className="cal-day__label">{dayLabel(items[0].at)}</h3>
              <ul className="cal-rows">{items.map((i) => i.node)}</ul>
            </div>
          ))
        )}
      </section>
      {posted.length > 0 && (
        <section>
          <h2 className="cal-section">Recently posted</h2>
          <ul className="cal-rows">
            {posted.map((g) => <PostRow key={g.key} g={g} onSelect={onSelect} showDate />)}
          </ul>
        </section>
      )}
    </div>
  );
}

const dayLabel = (d: Date) => (isToday(d) ? 'Today' : isTomorrow(d) ? 'Tomorrow' : format(d, 'EEEE, MMM d'));

function PostRow({ g, onSelect, showDate }: { g: PostGroup; onSelect: (g: PostGroup) => void; showDate?: boolean }) {
  const tag = g.accountGone ? 'Account disconnected' : g.status === 'pending' ? null : statusLabel(g);
  return (
    <li>
      <button type="button" className={`cal-row cal-row--${g.status}`} onClick={() => onSelect(g)}>
        <span className="cal-row__time">{format(g.at, showDate ? 'MMM d, p' : 'p')}</span>
        <Glyphs platforms={g.platforms} />
        <span className="cal-row__text">{firstLine(g.text)}</span>
        {tag && <span className={`badge${g.status === 'failed' || g.accountGone ? ' badge--err' : ''}`}>{tag}</span>}
      </button>
    </li>
  );
}

function ReviewRow({ r, showDate }: { r: ReviewItem; showDate?: boolean }) {
  return (
    <li>
      <Link href="/dashboard" className="cal-row cal-row--review">
        <span className="cal-row__time">{format(new Date(r.plannedAt!), showDate ? 'MMM d, p' : 'p')}</span>
        <Glyphs platforms={r.targetPlatforms ?? []} />
        <span className="cal-row__text">{r.title || firstLine(r.body)}</span>
        <span className="badge">Needs review</span>
      </Link>
    </li>
  );
}
