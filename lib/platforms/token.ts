import { eq } from 'drizzle-orm';
import { db } from '../db';
import { connectedAccounts, type Platform } from '../db/schema';
import { getAdapter } from './registry';
import { decryptToken, encryptToken, isEncrypted } from '../crypto/tokens';

const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

type AccountRow = typeof connectedAccounts.$inferSelect;

/**
 * Return a copy of the account row with tokens decrypted in memory. Use for
 * read paths that pass tokens to platform adapters. Storage remains encrypted.
 */
export function decryptAccount(acct: AccountRow): AccountRow {
  return {
    ...acct,
    accessToken: decryptToken(acct.accessToken) ?? acct.accessToken,
    refreshToken: acct.refreshToken ? decryptToken(acct.refreshToken) : null,
  };
}

/**
 * If the account's access token is close to expiry (or expired) and the
 * adapter supports refresh, swap in a fresh token and persist it. Returns
 * a row with decrypted tokens ready for use. On refresh failure the input
 * (decrypted) row is returned and the caller will surface a 401 — the user
 * then sees "Reconnect" on the Connections page.
 *
 * Accepts either an encrypted DB row or an already-decrypted row.
 */
export async function ensureFreshToken(acct: AccountRow): Promise<AccountRow> {
  const wasEncrypted = isEncrypted(acct.accessToken) || (acct.refreshToken !== null && isEncrypted(acct.refreshToken));
  const plain = wasEncrypted ? decryptAccount(acct) : acct;

  if (plain.isStub) return plain;
  if (!plain.tokenExpiresAt) {
    // Even when we don't refresh, opportunistically migrate plaintext rows to ciphertext.
    if (!wasEncrypted && plain.accessToken && plain.accessToken !== 'stub') {
      await db()
        .update(connectedAccounts)
        .set({
          accessToken: encryptToken(plain.accessToken),
          refreshToken: plain.refreshToken ? encryptToken(plain.refreshToken) : null,
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, plain.id));
    }
    return plain;
  }
  if (!plain.refreshToken) return plain;

  const adapter = getAdapter(plain.platform as Platform);
  // Each adapter owns its refresh policy. Long-lived tokens (Instagram 60d)
  // refresh well before expiry; short-lived (X 2h, YouTube 1h) wait until
  // the last few minutes. Default when an adapter doesn't override: refresh
  // when ≤ 5 min remain.
  const remaining = new Date(plain.tokenExpiresAt).getTime() - Date.now();
  const needsRefresh = adapter.shouldRefresh
    ? adapter.shouldRefresh(remaining)
    : remaining <= DEFAULT_REFRESH_WINDOW_MS;
  if (!needsRefresh) {
    // Migrate legacy plaintext row even without refresh.
    if (!wasEncrypted) {
      await db()
        .update(connectedAccounts)
        .set({
          accessToken: encryptToken(plain.accessToken),
          refreshToken: encryptToken(plain.refreshToken),
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, plain.id));
    }
    return plain;
  }

  if (!adapter.refresh) return plain;

  try {
    const tokens = await adapter.refresh(plain.refreshToken);
    const next = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? plain.refreshToken,
      tokenExpiresAt: tokens.expiresAt ?? null,
      scope: tokens.scope ?? plain.scope,
      updatedAt: new Date(),
    };
    await db()
      .update(connectedAccounts)
      .set({
        accessToken: encryptToken(next.accessToken),
        refreshToken: encryptToken(next.refreshToken),
        tokenExpiresAt: next.tokenExpiresAt,
        scope: next.scope,
        updatedAt: next.updatedAt,
      })
      .where(eq(connectedAccounts.id, plain.id));
    return { ...plain, ...next };
  } catch {
    return plain;
  }
}
