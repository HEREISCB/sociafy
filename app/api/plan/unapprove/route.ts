import { NextRequest } from 'next/server';
import { withUser } from '../../../../lib/api';
import { planUnapproveSchema, parseBody } from '../../../../lib/validation';
import { unapproveDrafts } from '../../../../lib/agent/plan';

// POST /api/plan/unapprove { items: [{ draftId, plannedAt: ISO | null }] }
// → { restored: draftId[], skipped: [{ draftId, reason: not_approved | already_posting }] }
// Undo for Approve / Approve all: the pending posts go, the draft is back in review at its old slot.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const parsed = parseBody(planUnapproveSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    return unapproveDrafts(user.id, parsed.data.items);
  }, req);
}
