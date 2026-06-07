import { eq } from 'drizzle-orm';
import { db } from '../db';
import { connectedAccounts, activityLog, type Platform } from '../db/schema';
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
 * a row with decrypted tokens ready for use.
 *
 * On refresh failure we log the error to activity_log and stamp
 * lastRefreshError/lastRefreshErrorAt on the row so the Connections page
 * can show a "Reconnect needed" badge. The returned row is still the
 * (decrypted) input so the immediate caller can attempt a publish — if the
 * token has any life left it might still work; if not, the publish fails
 * cleanly and the user already has the badge.
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
        lastRefreshAt: new Date(),
        lastRefreshError: null,
        lastRefreshErrorAt: null,
        updatedAt: next.updatedAt,
      })
      .where(eq(connectedAccounts.id, plain.id));
    return { ...plain, ...next, lastRefreshAt: new Date(), lastRefreshError: null, lastRefreshErrorAt: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const truncated = msg.slice(0, 500);
    const now = new Date();
    // Stamp the error onto the row so the UI can show a badge immediately,
    // and write an activity_log entry so it appears on the dashboard feed.
    // Only log once per (account, error) — re-stamping the column is cheap
    // but spamming activity_log every 6 hours is noisy. Compare against the
    // previous error and only insert when it changes.
    try {
      await db()
        .update(connectedAccounts)
        .set({
          lastRefreshError: truncated,
          lastRefreshErrorAt: now,
          updatedAt: now,
        })
        .where(eq(connectedAccounts.id, plain.id));
      if (plain.lastRefreshError !== truncated) {
        await db().insert(activityLog).values({
          userId: plain.userId,
          kind: 'platform_refresh_failed',
          title: `Reconnect needed: ${plain.platform}`,
          body: truncated,
          meta: {
            platform: plain.platform,
            accountId: plain.id,
            handle: plain.handle ?? null,
          },
        });
      }
    } catch {
      // If the DB write itself failed, drop the warning attempt and return
      // the stale token so the caller can decide what to do.
    }
    return { ...plain, lastRefreshError: truncated, lastRefreshErrorAt: now };
  }
}
