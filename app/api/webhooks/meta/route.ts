import { NextRequest } from 'next/server';
import { handleWebhookGet, handleWebhookPost, metaWebhookAdapter } from '../../../../lib/platforms/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Receives both Facebook Page and Instagram (via FB Login) events. The
// adapter's parse() emits each entry as a normalized WebhookEvent with the
// right `platform` set so the shared handler maps it to the correct row.
export function GET(req: NextRequest) {
  return handleWebhookGet(req, metaWebhookAdapter);
}

export function POST(req: NextRequest) {
  return handleWebhookPost(req, metaWebhookAdapter);
}
