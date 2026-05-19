import { NextRequest } from 'next/server';
import { withUser } from '../../../../lib/api';
import { runAgentForUser } from '../../../../lib/agent/run';
import { rateLimit } from '../../../../lib/rate-limit';

// POST /api/agent/run
// Triggers the agent for the current user, bypassing the weekly cadence cap.
// Used by the "Run agent now" button in the UI.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('agentRun', user.id);
    if (!rl.ok) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) } },
      );
    }
    const result = await runAgentForUser(user.id, { force: true });
    return result;
  }, req);
}
