import { withUser, jsonError } from '../../../../lib/api';
import { isStubMode } from '../../../../lib/env';
import { buildCrossPlatformRadar, HIGH_ALERT_HOURS } from '../../../../lib/intel/cross-platform-radar';

export const dynamic = 'force-dynamic';

export async function GET() {
  return withUser(async (user) => {
    if (isStubMode.database()) return jsonError('no cross-platform data yet', 404);
    const radar = await buildCrossPlatformRadar(user.id);
    return { ...radar, highAlertHours: HIGH_ALERT_HOURS };
  });
}
