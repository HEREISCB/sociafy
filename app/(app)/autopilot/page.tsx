import { redirect } from 'next/navigation';

// User-facing label is "Auto-pilot" so people guess /autopilot. Internal
// tab key is `agent`; route there.
export default function AutopilotRedirect() {
  redirect('/dashboard?tab=agent');
}
