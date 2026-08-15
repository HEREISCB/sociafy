/**
 * Day-grouping + time formatting for the compose media gallery.
 *
 * Everything here is LOCAL-calendar-day based on purpose: an asset created at
 * 01:00 belongs to the user's today, not to UTC's yesterday. `toDateString()`
 * is the local-day comparison; never compare ISO/UTC dates for this.
 */

/** Local calendar-day bucket key. */
export function dayKey(d: Date): string {
  return d.toDateString();
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (dayKey(d) === dayKey(today)) return 'TODAY';
  if (dayKey(d) === dayKey(yesterday)) return 'YESTERDAY';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

/**
 * ONE branch: same local calendar day → bare clock ("14:32"); any other day →
 * "Aug 6 · 14:32". An unknown timestamp formats to '' — callers decide what a
 * missing time looks like rather than getting a fake one.
 */
export function mediaTime(ts?: number): string {
  if (ts == null) return '';
  const d = new Date(ts);
  const clock = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (dayKey(d) === dayKey(new Date())) return clock;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${clock}`;
}

export type DayGroup<T> = { key: string; label: string; entries: Array<{ item: T; index: number }> };

/**
 * Pure: bucket items into local calendar days, newest day first, empty groups
 * dropped. Each entry carries its index in the source array so hero selection
 * and removal keep working against the flat list.
 *
 * Items with no timestamp are NOT filed under today — they get their own
 * trailing "UNDATED" group.
 */
export function groupByDay<T extends { createdAt?: number }>(items: T[]): DayGroup<T>[] {
  const buckets = new Map<string, { label: string; sort: number; entries: Array<{ item: T; index: number }> }>();
  items.forEach((item, index) => {
    const ts = item.createdAt;
    const key = ts == null ? ' undated' : dayKey(new Date(ts));
    let b = buckets.get(key);
    if (!b) {
      b = { label: ts == null ? 'UNDATED' : dayLabel(ts), sort: ts ?? -Infinity, entries: [] };
      buckets.set(key, b);
    }
    if (ts != null && ts > b.sort) b.sort = ts;
    b.entries.push({ item, index });
  });
  return [...buckets.entries()]
    .filter(([, b]) => b.entries.length > 0)
    .sort((a, b) => b[1].sort - a[1].sort)
    .map(([key, b]) => ({
      key,
      label: b.label,
      entries: [...b.entries].sort((x, y) => (y.item.createdAt ?? 0) - (x.item.createdAt ?? 0)),
    }));
}
