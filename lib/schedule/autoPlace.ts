import type { QuietHours } from '../db/schema';
import { inQuiet } from './windows';
import { MIN_GAP_MS } from './slots';

/** Local posting times a placed draft may land on: morning, lunch, afternoon, evening, night. */
export const DEFAULT_SLOTS = ['09:30', '12:30', '15:30', '18:30', '21:00'];
/** Most posts autoPlace puts on one day unless told otherwise. */
export const DEFAULT_PER_DAY = 3;
const HOUR = 60 * 60 * 1000;

/** Something to place: `kind` (text/image/video) and `group` (near-duplicates) are spread apart when possible. */
export type PlaceItem = { id: string; kind?: string; group?: string | null };
/** Something already on the calendar: counts toward its day's cap and blocks nearby slots. */
export type Taken = { at: Date; kind?: string; group?: string | null };

/** Two takes of one idea ("… (take 1)", "… (v2, bigger headline)", "… (6 s)") share a key. */
export const similarKey = (title: string | null | undefined) =>
  (title ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\b(v\d+|take \d+)\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || null;

const parts = (t: number, timeZone: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, Number(x.value)]),
  );
  return { y: p.year, m: p.month - 1, d: p.day, h: p.hour, min: p.minute };
};
/** How far `timeZone` is ahead of UTC at instant t (minute precision). */
const offset = (t: number, timeZone: string) => {
  const p = parts(t, timeZone);
  return Date.UTC(p.y, p.m, p.d, p.h, p.min) - Math.floor(t / 60_000) * 60_000;
};
/** The instant a wall clock in `timeZone` reads y-m-d hh:mm (second pass settles DST edges). */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  const wall = Date.UTC(y, m, d, hh, mm);
  return wall - offset(wall - offset(wall, timeZone), timeZone);
}
const dayKey = (t: number, timeZone: string) => { const p = parts(t, timeZone); return `${p.y}-${p.m}-${p.d}`; };

/**
 * Give drafts that have no time a slot: `days` local days starting with the
 * day `from` falls on, at the user's posting times, never within MIN_GAP_MS of
 * anything taken, never more than `perDay` on a day. Each item goes to the
 * emptiest day that still has room (earliest on a tie), avoiding a day that
 * already holds its group or kind; it takes that day's first free time.
 * Items that don't fit are left out of the result — they stay unscheduled.
 */
export function autoPlace(opts: {
  items: PlaceItem[];
  taken: Taken[];
  from: Date;
  days: number;
  timeZone: string;
  slots?: string[];
  perDay?: number;
  quiet?: QuietHours | null;
  /** Nothing lands sooner than this after `from`. */
  leadMs?: number;
}): Map<string, Date> {
  const { timeZone, perDay = DEFAULT_PER_DAY } = opts;
  const earliest = opts.from.getTime() + (opts.leadMs ?? HOUR);
  const times = (opts.slots ?? DEFAULT_SLOTS)
    .map((s) => s.split(':').map(Number))
    // Quiet hours are local wall-clock times here, like the posting slots.
    .filter(([h, m]) => !inQuiet(new Date(Date.UTC(1970, 0, 1, h, m)), opts.quiet));
  const start = parts(opts.from.getTime(), timeZone);
  const occupied = opts.taken.map((t) => t.at.getTime());
  const days = Array.from({ length: opts.days }, (_, i) => {
    const date = new Date(Date.UTC(start.y, start.m, start.d + i));
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
    const slots = times.map(([hh, mm]) => zonedTime(y, m, d, hh, mm, timeZone)).filter((t) => t >= earliest);
    const key = `${y}-${m}-${d}`;
    const on = opts.taken.filter((t) => dayKey(t.at.getTime(), timeZone) === key);
    return { slots, count: on.length, kinds: new Set(on.map((t) => t.kind)), groups: new Set(on.map((t) => t.group).filter(Boolean)) };
  });
  const free = (t: number) => occupied.every((o) => Math.abs(o - t) >= MIN_GAP_MS);

  const out = new Map<string, Date>();
  for (const it of opts.items) {
    let best: { day: (typeof days)[number]; at: number; score: number } | null = null;
    for (const day of days) {
      if (day.count >= perDay) continue;
      const at = day.slots.find(free);
      if (at === undefined) continue;
      const score = day.count * 4 + (it.kind && day.kinds.has(it.kind) ? 1 : 0) + (it.group && day.groups.has(it.group) ? 100 : 0);
      if (!best || score < best.score) best = { day, at, score };
    }
    if (!best) continue;
    out.set(it.id, new Date(best.at));
    occupied.push(best.at);
    best.day.count++;
    best.day.kinds.add(it.kind);
    if (it.group) best.day.groups.add(it.group);
  }
  return out;
}
