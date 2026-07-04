import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { shieldSettings, agentSettings } from '../../../../lib/db/schema';
import { runShieldScan } from '../../../../lib/shield/monitor';
import { env } from '../../../../lib/env';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Scheduled monitoring. Scans every user who opted into auto-fetch on the
// Reputation Shield. Brand = shieldSettings.autoFetchBrand, falling back to the
// user's agentSettings.companyName when not set. Crisis alerts (Slack/email)
// fire from inside runShieldScan when new crisis mentions are found.
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${env.cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

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

  return NextResponse.json({ scanned: results.length, results });
}
