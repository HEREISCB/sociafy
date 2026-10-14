import { NextRequest } from 'next/server';
import { withUser } from '../../../lib/api';
import { getPlan } from '../../../lib/agent/plan';

// GET /api/plan[?days=7|30] — the upcoming period: drafts to review, posts
// queued, counts, horizon and the next empty slot. Shape: PlanView in
// lib/agent/plan.ts. `days` previews another horizon without saving it.
export async function GET(req: NextRequest) {
  const d = Number(req.nextUrl.searchParams.get('days'));
  return withUser(async (user) => getPlan(user.id, new Date(), d === 7 || d === 30 ? d : undefined), req);
}
