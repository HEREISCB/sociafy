import { redirect } from 'next/navigation';

export default function AgentRedirect() {
  redirect('/dashboard?tab=agent');
}
