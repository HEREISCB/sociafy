/**
 * Settings › Accounts: one plain status line per connected account, plus the
 * sort rank that puts whatever needs the user at the top. Pure; built on the
 * same inputs as healthFor() so the badge and the line can't disagree.
 */

import { PLATFORM_LABELS } from './platforms';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type StatusAccount = {
  platform: string;
  isStub: boolean;
  tokenExpiresAt: string | null;
  autoRefresh?: boolean;
  lastRefreshError?: string | null;
};

export type AccountStatus = {
  /** 0 broken · 1 reconnect soon · 2 demo · 3 expiring live · 4 healthy. */
  rank: number;
  tone: 'bad' | 'warn' | 'ok';
  badge: string;
  /** One line: what's going on and what to do. */
  line: string;
  /** Show Reconnect as the row's primary (ink) action. */
  broken: boolean;
  /** Can't auto-renew and runs out within a week: a ghost Reconnect. */
  soon: boolean;
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "3 days", "5 h", "12 min". */
export function span(ms: number): string {
  if (ms >= DAY) return plural(Math.floor(ms / DAY), 'day');
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)} h`;
  return `${Math.max(1, Math.floor(ms / MIN))} min`;
}

export function accountStatus(a: StatusAccount, now: number, queued = 0): AccountStatus {
  const name = PLATFORM_LABELS[a.platform] ?? a.platform;
  const stuck = queued > 0 ? `${plural(queued, 'queued post')} won’t publish until you reconnect` : 'Reconnect to resume posting';
  if (a.isStub) {
    return { rank: 2, tone: 'warn', badge: 'Demo only', line: 'Placeholder account: nothing posts here. Connect the real account.', broken: true, soon: false };
  }
  if (a.lastRefreshError) {
    const why = a.lastRefreshError === 'reconnect_required' ? `${name} can’t renew access on its own` : 'Couldn’t renew access';
    return { rank: 0, tone: 'bad', badge: 'Reconnect needed', line: `${why} · ${stuck}`, broken: true, soon: false };
  }
  if (!a.tokenExpiresAt) {
    return { rank: 4, tone: 'ok', badge: 'Connected', line: 'Access doesn’t expire', broken: false, soon: false };
  }
  const left = new Date(a.tokenExpiresAt).getTime() - now;
  if (left <= 0 && !a.autoRefresh) {
    return { rank: 0, tone: 'bad', badge: 'Token expired', line: `Expired ${span(-left)} ago · ${stuck}`, broken: true, soon: false };
  }
  if (a.autoRefresh) {
    return { rank: 4, tone: 'ok', badge: 'Auto-renewing', line: left > 0 ? `Renews itself · next in ${span(left)}` : 'Renews itself before it posts', broken: false, soon: false };
  }
  if (left < 7 * DAY) {
    const by = new Date(a.tokenExpiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { rank: 1, tone: 'warn', badge: `Reconnect in ${span(left)}`, line: `${name} doesn’t auto-renew. Reconnect before ${by} to keep posting.`, broken: false, soon: true };
  }
  return { rank: 3, tone: 'ok', badge: 'Connected', line: `Expires in ${span(left)}`, broken: false, soon: false };
}
