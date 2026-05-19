import { eq } from 'drizzle-orm';
import { db } from '../db';
import { connectedAccounts, type Platform } from '../db/schema';
import { getAdapter } from './registry';

const REFRESH_WINDOW_MS = 5 * 60 * 1000;

type AccountRow = typeof connectedAccounts.$inferSelect;

/**
 * If the account's access token is close to expiry (or expired) and the
 * adapter supports refresh, swap in a fresh token and persist it. Returns
 * the (possibly updated) account row. If refresh fails the original row
 * is returned and the caller will surface the platform's 401 normally —
 * the user then sees "Reconnect" on the Connections page.
 */
export async function ensureFreshToken(acct: AccountRow): Promise<AccountRow> {
  if (acct.isStub) return acct;
  if (!acct.tokenExpiresAt) return acct;
  if (!acct.refreshToken) return acct;

  const remaining = new Date(acct.tokenExpiresAt).getTime() - Date.now();
  if (remaining > REFRESH_WINDOW_MS) return acct;

  const adapter = getAdapter(acct.platform as Platform);
  if (!adapter.refresh) return acct;

  try {
    const tokens = await adapter.refresh(acct.refreshToken);
    const next = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? acct.refreshToken,
      tokenExpiresAt: tokens.expiresAt ?? null,
      scope: tokens.scope ?? acct.scope,
      updatedAt: new Date(),
    };
    await db().update(connectedAccounts).set(next).where(eq(connectedAccounts.id, acct.id));
    return { ...acct, ...next };
  } catch {
    return acct;
  }
}
