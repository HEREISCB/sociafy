import { NextRequest } from 'next/server';
import { withUser } from '../../../../lib/api';
import { planApproveSchema, parseBody } from '../../../../lib/validation';
import { approveDrafts } from '../../../../lib/agent/plan';

// POST /api/plan/approve { draftIds?: uuid[], all?: true, overrides?: { [draftId]: ISO } }
// → { approved: [{ draftId, scheduledAt, platforms, reslotted }], skipped: [{ draftId, reason, reasons? }] }
// skipped.reason: not_found | rendering | not_a_draft | no_platforms (reasons has per-platform detail).
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const parsed = parseBody(planApproveSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    return approveDrafts(user.id, parsed.data);
  }, req);
}
