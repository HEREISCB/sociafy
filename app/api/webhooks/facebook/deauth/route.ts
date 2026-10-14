import { NextRequest } from 'next/server';
import { facebookCallbackConfig, handleDeauthCallback } from '../../../../../lib/platforms/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Facebook Login Deauthorize callback (App Dashboard → Facebook Login →
 * Settings → Deauthorize callback URL). signed_request is signed with
 * META_APP_SECRET and its user_id is the app-scoped user id (meta.userId).
 */
export function POST(req: NextRequest) {
  return handleDeauthCallback(req, facebookCallbackConfig);
}
