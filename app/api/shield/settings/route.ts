import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { shieldSettings } from '../../../../lib/db/schema';
import { authedUser } from '../../../../lib/api';
import { isAllowedWebhookUrl } from '../../../../lib/shield/notify';

export const runtime = 'nodejs';

const MAX_PROMPT = 8000;
// Deliberately loose: we only need "plausibly deliverable" to stop this field
// being used as a free-text spam relay through the platform's Resend sender.
const EMAIL_RX = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;

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
  // Empty string clears the field; anything else must survive validation.
  // Unvalidated these two were an SSRF (server POSTs to any URL, incl. cloud
  // metadata) and an open mail relay on our sender reputation.
  if (typeof body.slackWebhookUrl === 'string') {
    const url = body.slackWebhookUrl.trim().slice(0, 500);
    if (url && !isAllowedWebhookUrl(url)) {
      return NextResponse.json(
        { error: 'invalid_webhook_url', hint: 'Must be an https Slack (hooks.slack.com) or Discord incoming-webhook URL.' },
        { status: 400 },
      );
    }
    set.slackWebhookUrl = url || null;
  }
  if (typeof body.alertEmail === 'string') {
    const email = body.alertEmail.trim().slice(0, 200);
    if (email && !EMAIL_RX.test(email)) {
      return NextResponse.json({ error: 'invalid_alert_email' }, { status: 400 });
    }
    set.alertEmail = email || null;
  }

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
