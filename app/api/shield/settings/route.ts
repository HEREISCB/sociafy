import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { shieldSettings } from '../../../../lib/db/schema';
import { authedUser } from '../../../../lib/api';

export const runtime = 'nodejs';

const MAX_PROMPT = 8000;

type SettingsPayload = {
  systemPrompt: string;
  autoFetch: boolean;
  autoFetchBrand: string;
  slackWebhookUrl: string;
  alertEmail: string;
  lastAutoFetchAt: string | null;
};

function shape(row: typeof shieldSettings.$inferSelect | undefined): SettingsPayload {
  return {
    systemPrompt: row?.systemPrompt ?? '',
    autoFetch: row?.autoFetch ?? false,
    autoFetchBrand: row?.autoFetchBrand ?? '',
    slackWebhookUrl: row?.slackWebhookUrl ?? '',
    alertEmail: row?.alertEmail ?? '',
    lastAutoFetchAt: row?.lastAutoFetchAt ? row.lastAutoFetchAt.toISOString() : null,
  };
}

// GET — the user's shield settings.
export async function GET() {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const [row] = await db().select().from(shieldSettings).where(eq(shieldSettings.userId, user.id)).limit(1);
  return NextResponse.json({ settings: shape(row) });
}

// PUT — upsert any subset of the settings.
export async function PUT(req: NextRequest) {
  const user = await authedUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Partial<{
    systemPrompt: string;
    autoFetch: boolean;
    autoFetchBrand: string;
    slackWebhookUrl: string;
    alertEmail: string;
  }>;

  // Only set fields that were provided, so PATCH-like partial updates work.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.systemPrompt === 'string') set.systemPrompt = body.systemPrompt.slice(0, MAX_PROMPT);
  if (typeof body.autoFetch === 'boolean') set.autoFetch = body.autoFetch;
  if (typeof body.autoFetchBrand === 'string') set.autoFetchBrand = body.autoFetchBrand.trim().slice(0, 120);
  if (typeof body.slackWebhookUrl === 'string') set.slackWebhookUrl = body.slackWebhookUrl.trim().slice(0, 500);
  if (typeof body.alertEmail === 'string') set.alertEmail = body.alertEmail.trim().slice(0, 200);

  await db()
    .insert(shieldSettings)
    .values({
      userId: user.id,
      systemPrompt: typeof set.systemPrompt === 'string' ? (set.systemPrompt as string) : '',
      autoFetch: typeof set.autoFetch === 'boolean' ? (set.autoFetch as boolean) : false,
      autoFetchBrand: (set.autoFetchBrand as string) ?? null,
      slackWebhookUrl: (set.slackWebhookUrl as string) ?? null,
      alertEmail: (set.alertEmail as string) ?? null,
    })
    .onConflictDoUpdate({ target: shieldSettings.userId, set });

  const [row] = await db().select().from(shieldSettings).where(eq(shieldSettings.userId, user.id)).limit(1);
  return NextResponse.json({ ok: true, settings: shape(row) });
}
