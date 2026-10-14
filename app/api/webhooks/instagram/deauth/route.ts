import { NextRequest } from 'next/server';
import { handleDeauthCallback, instagramCallbackConfig } from '../../../../../lib/platforms/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Instagram Deauthorize callback.
 *
 * Triggered when a user removes Sociafy from their Instagram account
 * settings. Meta POSTs a `signed_request`; we verify it, then drop the
 * matching connected_accounts row (matched on platformUserId OR
 * meta.igScopedId). Responds 200 even if no account matched so Meta doesn't
 * retry forever.
 */
export function POST(req: NextRequest) {
  return handleDeauthCallback(req, instagramCallbackConfig);
}
