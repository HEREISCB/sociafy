import { NextRequest } from 'next/server';
import { handleWebhookGet, handleWebhookPost, instagramWebhookAdapter } from '../../../../lib/platforms/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Instagram webhook handler — dedicated to the "Instagram API with Instagram
 * Login" product. The FB-side webhook at /api/webhooks/meta handles the
 * Facebook Login flow; this one handles direct IG Login subscriptions and
 * is signed with INSTAGRAM_APP_SECRET (separate from META_APP_SECRET).
 *
 * Setup in Meta dashboard:
 *   App → Instagram product → Webhooks → set Callback URL to this route's
 *   URL and Verify Token to env.platforms.meta.webhookVerifyToken. Subscribe
 *   to the `instagram` object with the fields you care about.
 */

export function GET(req: NextRequest) {
  return handleWebhookGet(req, instagramWebhookAdapter);
}

export function POST(req: NextRequest) {
  return handleWebhookPost(req, instagramWebhookAdapter);
}
