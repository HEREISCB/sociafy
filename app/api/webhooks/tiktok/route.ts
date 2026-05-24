import { NextRequest } from 'next/server';
import { handleWebhookGet, handleWebhookPost, tiktokWebhookAdapter } from '../../../../lib/platforms/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  return handleWebhookGet(req, tiktokWebhookAdapter);
}

export function POST(req: NextRequest) {
  return handleWebhookPost(req, tiktokWebhookAdapter);
}
