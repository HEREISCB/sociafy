import { NextRequest } from 'next/server';
import {
  facebookCallbackConfig,
  handleDataDeletionCallback,
  handleDataDeletionStatus,
} from '../../../../../lib/platforms/webhook';
import { getOrigin } from '../../../../../lib/url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Facebook Data Deletion Request callback (App Dashboard → App settings →
 * Basic → Data deletion request URL). Returns Meta's required
 * { url, confirmation_code }; GET ?code= on this route reports the status.
 */
export function POST(req: NextRequest) {
  return handleDataDeletionCallback(
    req,
    facebookCallbackConfig,
    `${getOrigin(req)}/api/webhooks/facebook/data-deletion`,
  );
}

export function GET(req: NextRequest) {
  return handleDataDeletionStatus(req, facebookCallbackConfig);
}
