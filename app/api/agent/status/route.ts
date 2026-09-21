import { withUser } from '../../../../lib/api';
import { getAgentStatus } from '../../../../lib/agent/status';

// GET /api/agent/status
// What autopilot is doing right now and when it acts next — the status card.
export async function GET() {
  return withUser(async (user) => getAgentStatus(user.id));
}
