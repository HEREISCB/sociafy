import { NextRequest, NextResponse } from 'next/server';
import { generateScript } from '../../../../../lib/demo/shield-script';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { brand, mention } = body;

  if (!brand || !mention) {
    return NextResponse.json({ error: 'brand and mention required' }, { status: 400 });
  }

  const result = await generateScript({
    brand: String(brand).slice(0, 80),
    allegation: `${mention.title ?? ''} ${mention.body ?? ''}`.slice(0, 400),
    theme: mention.sentiment?.theme ?? 'General Reputation',
    source: mention.source ?? 'web',
    severity: mention.sentiment?.severity ?? 5,
  });

  return NextResponse.json(result);
}
