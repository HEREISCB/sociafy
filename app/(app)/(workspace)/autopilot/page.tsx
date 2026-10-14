'use client';

import { useRouter } from 'next/navigation';
import AgentPage from '../../../../components/agent';

export default function AutopilotPage() {
  const router = useRouter();
  return (
    <>
      <div className="page-head">
        <div><h1>Autopilot</h1></div>
      </div>
      <AgentPage onEditDraft={(id) => router.push(`/compose?draft=${encodeURIComponent(id)}`)} />
    </>
  );
}
