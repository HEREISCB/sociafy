import { NextRequest } from 'next/server';
import {
  handleDataDeletionCallback,
  handleDataDeletionStatus,
  instagramCallbackConfig,
} from '../../../../../lib/platforms/webhook';
import { getOrigin } from '../../../../../lib/url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Instagram Data Deletion Request callback. Returns Meta's required
 * { url, confirmation_code }; GET ?code= on this route reports the status.
 */
export function POST(req: NextRequest) {
  return handleDataDeletionCallback(
    req,
    instagramCallbackConfig,
    `${getOrigin(req)}/api/webhooks/instagram/data-deletion`,
  );
}

export function GET(req: NextRequest) {
  return handleDataDeletionStatus(req, instagramCallbackConfig);
}
