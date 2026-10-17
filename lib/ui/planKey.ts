/**
 * Smart video card keys. `input` is the post (text, platforms, attachments); `full` adds the
 * user's format override. Every plan request, response and cache entry is keyed by `full`.
 */
export function planKeys(text: string, platforms: string[], attachments: { url: string }[], override: unknown) {
  const input = JSON.stringify([text.trim(), platforms, attachments.map((a) => a.url)]);
  return { input, full: JSON.stringify([input, override ?? null]) };
}

export type Keyed<T> = { key: string; input: string; res: T };

/**
 * What the card may show: the plan for exactly these inputs, else (while an override re-plans)
 * the same post's last plan, flagged not current. Never another post's plan.
 */
export function shownPlan<T>(keys: { input: string; full: string }, exact: T | null, last: Keyed<T> | null): { res: T | null; current: boolean } {
  if (exact) return { res: exact, current: true };
  if (last?.key === keys.full) return { res: last.res, current: true };
  if (last?.input === keys.input) return { res: last.res, current: false };
  return { res: null, current: false };
}
