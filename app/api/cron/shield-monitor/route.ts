import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { agentSettings } from '../../../../lib/db/schema';
import { runShieldScan } from '../../../../lib/shield/monitor';
import { env } from '../../../../lib/env';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${env.cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Find all users who have a brand name configured in agentSettings
  const settings = await db()
    .select({ userId: agentSettings.userId, brand: agentSettings.companyName })
    .from(agentSettings)
    .where(eq(agentSettings.enabled, true));

  const results: Record<string, unknown>[] = [];

  for (const s of settings) {
    if (!s.brand) continue;
    try {
      const result = await runShieldScan({ userId: s.userId, brand: s.brand });
      results.push({ userId: s.userId, brand: s.brand, ...result });
    } catch (e) {
      results.push({ userId: s.userId, brand: s.brand, error: String(e) });
    }
  }

  return NextResponse.json({ scanned: results.length, results });
}
