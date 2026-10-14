import { withUser } from '../../../lib/api';
import { getPlan } from '../../../lib/agent/plan';

// GET /api/plan — the upcoming period: drafts to review, posts queued, counts,
// horizon and the next empty slot. Shape: PlanView in lib/agent/plan.ts.
export async function GET() {
  return withUser(async (user) => getPlan(user.id));
}
