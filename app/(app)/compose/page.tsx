import { redirect } from 'next/navigation';

// The workspace tabs (compose, calendar, agent, connections) live inside
// /dashboard as query-param panes. Direct hits to /compose etc. would 404
// without this shim — common when users bookmark a deep link or share one
// externally.
export default function ComposeRedirect() {
  redirect('/dashboard?tab=compose');
}
