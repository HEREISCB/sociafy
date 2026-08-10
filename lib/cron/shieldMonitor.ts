import { eq } from 'drizzle-orm';
import { db } from '../db';
import { shieldSettings, agentSettings } from '../db/schema';
import { runShieldScan } from '../shield/monitor';

/**
 * Scheduled monitoring across every user who opted into auto-fetch on the
 * Reputation Shield. lib/shield/monitor.ts scans one user; this is the fan-out.
 *
 * Called by `/api/cron/shield-monitor` (HTTP) and by `scripts/cron-run.mjs
 * shield-monitor` (on-box cron). Brand = shieldSettings.autoFetchBrand, falling
 * back to the user's agentSettings.companyName when unset. Crisis alerts
 * (Slack/email) fire from inside runShieldScan when new crisis mentions land.
 *
 * Per-user failures are recorded, never thrown: one user's revoked token must
 * not stop the scan for everyone behind them in the loop.
 */
export async function runShieldMonitor(): Promise<{ scanned: number; results: Record<string, unknown>[] }> {
  const optedIn = await db()
    .select({ userId: shieldSettings.userId, brand: shieldSettings.autoFetchBrand })
    .from(shieldSettings)
    .where(eq(shieldSettings.autoFetch, true));

  const results: Record<string, unknown>[] = [];

  for (const s of optedIn) {
    let brand = s.brand?.trim() || '';
    if (!brand) {
      const [agent] = await db()
        .select({ companyName: agentSettings.companyName })
        .from(agentSettings)
        .where(eq(agentSettings.userId, s.userId))
        .limit(1);
      brand = agent?.companyName?.trim() || '';
    }
    if (!brand) continue;

    try {
      const result = await runShieldScan({ userId: s.userId, brand });
      await db()
        .update(shieldSettings)
        .set({ lastAutoFetchAt: new Date() })
        .where(eq(shieldSettings.userId, s.userId));
      results.push({ userId: s.userId, brand, ...result });
    } catch (e) {
      results.push({ userId: s.userId, brand, error: String(e) });
    }
  }

  return { scanned: results.length, results };
}
