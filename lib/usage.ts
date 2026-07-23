import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from './db';
import { apiUsage, type UsageMeter } from './db/schema';
import { isStubMode } from './env';
import { jsonError } from './api';

// ponytail: flat monthly quotas as constants; move to a plans table when billing exists
export const METERS: Record<UsageMeter, { label: string; monthlyLimit: number }> = {
  caption_generation: { label: 'AI Captions', monthlyLimit: 100 },
  analysis: { label: 'Analysis', monthlyLimit: 200 },
  post_publish: { label: 'Publishing', monthlyLimit: 50 },
  video: { label: 'Video Uploads', monthlyLimit: 10 },
  brandshield_scan: { label: 'BrandShield Scans', monthlyLimit: 30 },
};

function monthStart(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export async function recordUsage(
  userId: string,
  meter: UsageMeter,
  amount = 1,
  meta: Record<string, unknown> = {},
): Promise<void> {
  if (isStubMode.database()) return;
  await db().insert(apiUsage).values({ userId, meter, amount, meta });
}

export type UsageSummary = Array<{
  meter: UsageMeter;
  label: string;
  used: number;
  limit: number;
}>;

export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  const used = new Map<UsageMeter, number>();
  if (!isStubMode.database()) {
    const rows = await db()
      .select({ meter: apiUsage.meter, total: sql<number>`sum(${apiUsage.amount})::int` })
      .from(apiUsage)
      .where(and(eq(apiUsage.userId, userId), gte(apiUsage.createdAt, monthStart())))
      .groupBy(apiUsage.meter);
    for (const r of rows) used.set(r.meter, r.total);
  }
  return (Object.keys(METERS) as UsageMeter[]).map((meter) => ({
    meter,
    label: METERS[meter].label,
    used: used.get(meter) ?? 0,
    limit: METERS[meter].monthlyLimit,
  }));
}

/** Throws a 429 Response when the meter is exhausted; callers inside withUser get it serialized. */
export async function checkQuota(userId: string, meter: UsageMeter): Promise<void> {
  if (isStubMode.database()) return;
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${apiUsage.amount}), 0)::int` })
    .from(apiUsage)
    .where(and(
      eq(apiUsage.userId, userId),
      eq(apiUsage.meter, meter),
      gte(apiUsage.createdAt, monthStart()),
    ));
  if ((row?.total ?? 0) >= METERS[meter].monthlyLimit) {
    throw jsonError('quota_exceeded', 429, { meter });
  }
}
