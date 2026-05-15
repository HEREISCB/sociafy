import { withUser } from '../../../../lib/api';
import { runAgentForUser } from '../../../../lib/agent/run';

// POST /api/agent/run
// Triggers the agent for the current user, bypassing the weekly cadence cap.
// Used by the "Run agent now" button in the UI.
export async function POST() {
  return withUser(async (user) => {
    const result = await runAgentForUser(user.id, { force: true });
    return result;
  });
}
