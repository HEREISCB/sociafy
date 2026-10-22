import { NextRequest } from 'next/server';
import { withUser } from '../../../../lib/api';
import { planApproveSchema, parseBody } from '../../../../lib/validation';
import { approveDrafts } from '../../../../lib/agent/plan';

// POST /api/plan/approve { draftIds?: uuid[], all?: true, overrides?: { [draftId]: ISO } }
// → { approved: [{ draftId, scheduledAt, platforms, reslotted, rendering? }], skipped: [{ draftId, reason, reasons?, platforms? }] }
// A video still rendering is approved ahead of its clip (rendering: true) and scheduled when it lands.
// skipped.reason: not_found | not_a_draft | no_platforms (reasons has per-platform detail; "disconnected" = needs reconnecting, left out) | too_long (platforms over their char limit).
// approved[].platforms leaves out accounts that need reconnecting: the cron would fail those posts at their slot.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const parsed = parseBody(planApproveSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    return approveDrafts(user.id, parsed.data);
  }, req);
}
