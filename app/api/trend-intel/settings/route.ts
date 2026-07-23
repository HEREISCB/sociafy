import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser, jsonOk, jsonError } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { db } from '../../../../lib/db';
import { trendSettings } from '../../../../lib/db/schema';

export async function GET() {
  return withUser(async (user) => {
    if (isStubMode.database()) return { hashtags: [], niche: null };
    const [row] = await db().select().from(trendSettings).where(eq(trendSettings.userId, user.id)).limit(1);
    return {
      hashtags: row?.trackedHashtags ?? [], niche: row?.niche ?? null, selfHandle: row?.selfHandle ?? null,
      companyDescription: row?.companyDescription ?? null,
    };
  });
}

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const body = await req.json().catch(() => ({}));
    const hashtags = Array.isArray(body.hashtags)
      ? body.hashtags.map((h: unknown) => String(h).trim()).filter(Boolean).slice(0, 20)
      : [];
    if (hashtags.length === 0) return jsonError('hashtags required');
    const niche = typeof body.niche === 'string' ? body.niche.slice(0, 120) : null;
    const selfHandle = typeof body.selfHandle === 'string'
      ? body.selfHandle.trim().replace(/^@/, '').slice(0, 60) || null
      : undefined; // undefined = don't touch existing value
    const companyDescription = typeof body.companyDescription === 'string'
      ? body.companyDescription.trim().slice(0, 2000) || null
      : undefined; // undefined = don't touch existing value
    const set: Record<string, unknown> = { trackedHashtags: hashtags, niche, updatedAt: new Date() };
    if (selfHandle !== undefined) set.selfHandle = selfHandle;
    if (companyDescription !== undefined) set.companyDescription = companyDescription;
    await db().insert(trendSettings)
      .values({
        userId: user.id, trackedHashtags: hashtags, niche, selfHandle: selfHandle ?? null,
        companyDescription: companyDescription ?? null, updatedAt: new Date(),
      })
      .onConflictDoUpdate({ target: trendSettings.userId, set });
    return jsonOk({ hashtags, niche, selfHandle: selfHandle ?? null, companyDescription: companyDescription ?? null });
  }, req);
}
