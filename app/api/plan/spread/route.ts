import { NextRequest } from 'next/server';
import { withUser, jsonError } from '../../../../lib/api';
import { planSpreadSchema, parseBody } from '../../../../lib/validation';
import { spreadDrafts } from '../../../../lib/agent/plan';
import { rateLimit } from '../../../../lib/rate-limit';

// POST /api/plan/spread { timeZone } → { placed: [{ draftId, plannedAt, previous }], left }
// Gives the caller's unscheduled drafts proposed times across the plan horizon.
// Only planned_at changes: they stay drafts to review — nothing is approved or queued.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('agentRun', `spread:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const parsed = parseBody(planSpreadSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    return spreadDrafts(user.id, parsed.data.timeZone);
  }, req);
}
