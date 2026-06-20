import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../../../../lib/db';
import { shieldActions, mentions } from '../../../../../../lib/db/schema';
import { authedUser } from '../../../../../../lib/api';
import { generateScript } from '../../../../../../lib/shield/script';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;

  const rows = await db()
    .select({ action: shieldActions, mention: mentions })
    .from(shieldActions)
    .innerJoin(mentions, eq(shieldActions.mentionId, mentions.id))
    .where(and(eq(shieldActions.id, id), eq(shieldActions.userId, user.id)))
    .limit(1);

  if (!rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { action, mention } = rows[0];

  const result = await generateScript({
    brand: mention.brand,
    allegation: `${mention.title} ${mention.body}`.slice(0, 400),
    theme: mention.theme,
    source: mention.source,
    severity: mention.severity,
  });

  await db()
    .update(shieldActions)
    .set({ script: result.script, updatedAt: new Date() })
    .where(eq(shieldActions.id, id));

  return NextResponse.json({ script: result.script, usedAI: result.usedAI });
}
