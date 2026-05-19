import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';
import { isStubMode } from '../../../lib/env';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const startTime = Date.now();

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  let allOk = true;

  // DB ping — cheap SELECT 1 — short-circuits if stub mode.
  if (isStubMode.database()) {
    checks.database = { ok: false, detail: 'no_database_url' };
    allOk = false;
  } else {
    try {
      await db().execute(sql`SELECT 1`);
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, detail: e instanceof Error ? e.message : 'db_error' };
      allOk = false;
    }
  }

  // Env presence — don't leak the secrets, just whether they're configured.
  checks.config = {
    ok: !!process.env.INTERNAL_API_SECRET && !!process.env.CRON_SECRET,
    detail:
      !process.env.INTERNAL_API_SECRET
        ? 'INTERNAL_API_SECRET missing'
        : !process.env.CRON_SECRET
        ? 'CRON_SECRET missing'
        : undefined,
  };
  if (!checks.config.ok) allOk = false;

  return NextResponse.json(
    {
      ok: allOk,
      service: 'sociafy-app',
      uptimeSec: Math.floor((Date.now() - startTime) / 1000),
      checks,
    },
    { status: allOk ? 200 : 503 },
  );
}
