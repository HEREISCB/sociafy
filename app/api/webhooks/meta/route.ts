import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { activityLog, connectedAccounts, type Platform } from '../../../../lib/db/schema';
import { env } from '../../../../lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Meta webhook verification (one-shot during setup).
// Meta sends a GET with hub.mode=subscribe & hub.verify_token=<your_token> & hub.challenge=<n>.
// We must respond with the challenge as plain text if the verify_token matches.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  const expected = env.platforms.meta.webhookVerifyToken;
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: 'verify_failed' }, { status: 403 });
}

function verifySignature(rawBody: string, header: string | null): boolean {
  if (!env.platforms.meta.appSecret) return false;
  if (!header) return false;
  const expected = `sha256=${crypto
    .createHmac('sha256', env.platforms.meta.appSecret)
    .update(rawBody)
    .digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

type MetaEvent = {
  object?: 'page' | 'instagram' | 'user';
  entry?: Array<{
    id: string;
    time?: number;
    changes?: Array<{ field: string; value: Record<string, unknown> }>;
  }>;
};

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get('x-hub-signature-256');
  const verified = verifySignature(rawBody, signature);

  console.log('[meta-webhook]', { verified, bodyLen: rawBody.length });

  if (!verified) {
    return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });
  }

  let payload: MetaEvent = {};
  try {
    payload = JSON.parse(rawBody) as MetaEvent;
  } catch {
    return NextResponse.json({ ok: true, parsed: false });
  }

  const entries = payload.entry ?? [];
  const platformKey: Platform = payload.object === 'instagram' ? 'instagram' : 'facebook';
  let logged = 0;
  for (const entry of entries) {
    const rows = await db()
      .select({ userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.platform, platformKey),
          eq(connectedAccounts.platformUserId, entry.id),
        ),
      )
      .limit(1);
    const userId = rows[0]?.userId;
    if (!userId) continue;
    const fields = (entry.changes ?? []).map((c) => c.field).join(', ') || 'event';
    await db().insert(activityLog).values({
      userId,
      kind: 'webhook_event',
      title: `${platformKey === 'instagram' ? 'Instagram' : 'Facebook'} · ${fields}`,
      meta: { platform: platformKey, entry, verified: true },
    });
    logged += 1;
  }

  return NextResponse.json({ ok: true, entries: entries.length, logged });
}
