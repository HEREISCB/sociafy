import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { db } from '../db';
import { connectedAccounts } from '../db/schema';
import { ensureFreshToken } from '../platforms/token';

export type RefreshResult = {
  id: string;
  platform: string;
  refreshed: boolean;
  error?: string;
};

// Scan window for tokens to consider refreshing. Set just past the longest
// adapter-specific horizon (Instagram's 14d) so every account that COULD
// need a refresh gets picked up. ensureFreshToken then decides per-adapter
// whether to actually refresh — short-lived tokens (X, YouTube) inside this
// window still wait until they're close to expiry.
const HORIZON_HOURS = 15 * 24;

export async function runRefreshTokens(): Promise<{ scanned: number; results: RefreshResult[] }> {
  const horizon = new Date(Date.now() + HORIZON_HOURS * 60 * 60 * 1000);
  const candidates = await db()
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.isStub, false),
        isNotNull(connectedAccounts.tokenExpiresAt),
        isNotNull(connectedAccounts.refreshToken),
        lte(connectedAccounts.tokenExpiresAt, horizon),
      ),
    );

  const results: RefreshResult[] = [];
  for (const acct of candidates) {
    const beforeExp = acct.tokenExpiresAt?.getTime() ?? 0;
    const after = await ensureFreshToken(acct);
    const afterExp = after.tokenExpiresAt?.getTime() ?? 0;
    const refreshed = afterExp > beforeExp;
    // ensureFreshToken now writes lastRefreshError to the row on failure —
    // surface a short error string in the cron output so admins running it
    // by hand can see what failed at a glance.
    const lastErr = (after as { lastRefreshError?: string | null }).lastRefreshError ?? null;
    results.push({
      id: acct.id,
      platform: acct.platform,
      refreshed,
      ...(!refreshed && lastErr ? { error: lastErr } : {}),
    });
  }

  return { scanned: candidates.length, results };
}
