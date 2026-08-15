/**
 * Connection health — the single source of truth for "is this account
 * actually able to publish right now".
 *
 * Lifted out of components/connections.tsx so the dashboard and the
 * Connections page can't disagree about the same account (the dashboard used
 * to paint a green "Live" dot for a token that Connections was flagging as
 * "Reconnect needed"). connections.tsx still carries its own copy — another
 * agent owns that file right now; swap it for this import when it's free.
 */

const DAY = 86_400_000;

export type Health = {
  status: 'live' | 'expiring' | 'expired' | 'persistent' | 'stub' | 'offline';
  label: string;
  detail: string;
  pct: number; // 0-100 fill for the bar
  tone: 'good' | 'warn' | 'bad' | 'neutral' | 'accent';
};

/** The subset of an /api/accounts row that health depends on. */
export type HealthAccount = {
  isStub: boolean;
  tokenExpiresAt: string | null;
  autoRefresh?: boolean;
  lastRefreshError?: string | null;
};

export const toneColor: Record<Health['tone'], string> = {
  good: 'var(--good)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  accent: 'var(--accent)',
  neutral: 'var(--ink-4)',
};

export function healthFor(acct: HealthAccount | null, now: number): Health {
  if (!acct) return { status: 'offline', label: 'Not connected', detail: '—', pct: 0, tone: 'neutral' };
  if (acct.isStub) return { status: 'stub', label: 'Demo only', detail: 'won\'t post — placeholder account', pct: 100, tone: 'warn' };
  if (acct.lastRefreshError) {
    return {
      status: 'expired',
      label: 'Reconnect needed',
      // 'reconnect_required' is stamped by ensureFreshToken for platforms that
      // have no refresh flow at all (LinkedIn) — nothing "failed", the token
      // simply can't be renewed without the user.
      detail: acct.lastRefreshError === 'reconnect_required' ? 'can\'t auto-renew — reconnect' : 'last refresh failed',
      pct: 100,
      tone: 'bad',
    };
  }
  if (!acct.tokenExpiresAt) {
    return { status: 'persistent', label: 'Long-lived', detail: 'token does not expire', pct: 100, tone: 'good' };
  }
  const exp = new Date(acct.tokenExpiresAt).getTime();
  const diff = exp - now;
  if (diff <= 0) return { status: 'expired', label: 'Token expired', detail: 'reconnect to resume publishing', pct: 100, tone: 'bad' };
  const days = Math.floor(diff / DAY);
  const hrs = Math.floor((diff % DAY) / 3_600_000);
  const timeLeft =
    days >= 1
      ? `${days}d ${hrs}h`
      : diff > 3_600_000
      ? `${hrs}h ${Math.floor((diff % 3_600_000) / 60_000)}m`
      : `${Math.max(1, Math.floor(diff / 60_000))}m`;

  // Auto-renewing tokens get a calmer status — the expiry is a number the
  // user can see, but the platform will refresh before we hit it.
  if (acct.autoRefresh) {
    const SIXTY = 60 * DAY;
    const pct = Math.max(12, Math.min(100, (diff / SIXTY) * 100));
    return { status: 'live', label: 'Auto-renewing', detail: `auto · ${timeLeft} left`, pct, tone: 'good' };
  }

  if (diff < 24 * 3_600_000) {
    const pct = Math.max(8, Math.min(100, (diff / (24 * 3_600_000)) * 100));
    return { status: 'expiring', label: 'Refresh soon', detail: `expires in ${timeLeft}`, pct, tone: 'warn' };
  }
  // 60-day reference window for live bar fill
  const SIXTY = 60 * DAY;
  const pct = Math.max(12, Math.min(100, (diff / SIXTY) * 100));
  return { status: 'live', label: 'Connected', detail: `expires in ${timeLeft}`, pct, tone: 'accent' };
}
