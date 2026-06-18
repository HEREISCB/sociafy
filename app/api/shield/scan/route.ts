import { NextRequest, NextResponse } from 'next/server';
import { authedUser } from '../../../../lib/api';
import { runShieldScan } from '../../../../lib/shield/monitor';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { brand?: string };
  const brand = String(body.brand ?? '').trim();

  if (!brand || brand.length < 2) {
    return NextResponse.json({ error: 'brand required (min 2 chars)' }, { status: 400 });
  }
  if (brand.length > 80) {
    return NextResponse.json({ error: 'brand name too long' }, { status: 400 });
  }

  const result = await runShieldScan({ userId: user.id, brand });
  return NextResponse.json(result);
}
