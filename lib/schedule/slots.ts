import type { QuietHours } from '../db/schema';
import { BUSINESS_WINDOWS, inQuiet, nextPostingWindow } from './windows';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Two posts closer than this crowd each other; a slot this near a taken one is not free. */
export const MIN_GAP_MS = 2 * HOUR;

/**
 * Every legal posting time in [from + 1h, to): one per business window per UTC
 * day, at a random half-hour inside the window (spread, not bursts), never in
 * quiet hours. A day whose quiet hours swallow every business window falls back
 * to non-quiet times — same rule as nextPostingWindow: quiet hours are an
 * instruction, business windows a preference.
 */
export function candidateSlots(from: Date, to: Date, quiet?: QuietHours | null, rand = Math.random): Date[] {
  const start = from.getTime() + HOUR;
  const end = to.getTime();
  const out: Date[] = [];
  const pick = (ts: number[]) => ts.length ? [ts[Math.floor(rand() * ts.length)]] : [];
  const steps = (s: number, e: number, d: number) =>
    Array.from({ length: Math.round((e - s) * 2) }, (_, i) => d + (s + i / 2) * HOUR).filter((t) => !inQuiet(new Date(t), quiet));
  for (let d = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); d < end; d += DAY) {
    const windows = BUSINESS_WINDOWS.map(([s, e]) => steps(s, e, d)).filter((w) => w.length);
    // Quiet hours cover every window: fall back to 08:00-21:00 outside them.
    const day = windows.length ? windows : [steps(8, 21, d)];
    for (const w of day) out.push(...pick(w.filter((t) => t >= start && t < end)).map((t) => new Date(t)));
  }
  return out;
}

const isFree = (t: number, taken: number[]) => taken.every((o) => Math.abs(o - t) >= MIN_GAP_MS);

/**
 * Spread `count` posts over [from, from + horizonDays) without landing near a
 * time already taken (pending scheduled posts, other planned drafts). Greedy
 * max-min distance: each pick is the free candidate farthest from everything
 * already on the calendar, so a 7-a-week plan lands about one a day and a
 * top-up fills the biggest gaps first. Returns fewer than `count` when the
 * horizon has no room left. Sorted ascending.
 */
export function planSlots(opts: {
  from: Date;
  horizonDays: number;
  count: number;
  quiet?: QuietHours | null;
  taken: Date[];
  rand?: () => number;
}): Date[] {
  const occupied = opts.taken.map((d) => d.getTime());
  let free = candidateSlots(opts.from, new Date(opts.from.getTime() + opts.horizonDays * DAY), opts.quiet, opts.rand)
    .map((d) => d.getTime())
    .filter((t) => isFree(t, occupied));
  const picked: number[] = [];
  while (picked.length < opts.count && free.length) {
    let best = 0;
    let bestDist = -1;
    free.forEach((t, i) => {
      const dist = occupied.length ? Math.min(...occupied.map((o) => Math.abs(o - t))) : Infinity;
      if (dist > bestDist) { best = i; bestDist = dist; }
    });
    const t = free[best];
    picked.push(t);
    occupied.push(t);
    free = free.filter((f) => isFree(f, [t]));
  }
  return picked.sort((a, b) => a - b).map((t) => new Date(t));
}

/** The earliest free legal slot after `from` — where an approved post whose planned time has passed goes. */
export function nextFreeSlot(from: Date, quiet: QuietHours | null | undefined, taken: Date[], rand = Math.random): Date {
  const occupied = taken.map((d) => d.getTime());
  return candidateSlots(from, new Date(from.getTime() + 14 * DAY), quiet, rand).find((c) => isFree(c.getTime(), occupied))
    ?? nextPostingWindow(from, quiet);
}
