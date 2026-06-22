import { NextRequest, NextResponse } from 'next/server';
import { authedUser } from '../../../../lib/api';
import { runShieldScan } from '../../../../lib/shield/monitor';
import type { MentionSourceId } from '../../../../lib/shield/sources';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ALLOWED_SOURCES: MentionSourceId[] = ['google_news', 'hackernews', 'wikipedia', 'reddit', 'x'];

export async function POST(req: NextRequest) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { brand?: string; sources?: unknown };
  const brand = String(body.brand ?? '').trim();

  if (!brand || brand.length < 2) {
    return NextResponse.json({ error: 'brand required (min 2 chars)' }, { status: 400 });
  }
  if (brand.length > 80) {
    return NextResponse.json({ error: 'brand name too long' }, { status: 400 });
  }

  // Optional source filter (e.g. ['x'] for an X/Twitter-only scan).
  const sources = Array.isArray(body.sources)
    ? (body.sources.filter((s): s is MentionSourceId => ALLOWED_SOURCES.includes(s as MentionSourceId)))
    : undefined;

  try {
    const result = await runShieldScan({
      userId: user.id,
      brand,
      sources: sources && sources.length ? sources : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[shield/scan] runShieldScan threw:', msg, err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
