'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSWRConfig } from 'swr';
import Dashboard from '../../../../components/dashboard';

export default function HomePage() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [refreshing, setRefreshing] = useState(false);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await mutate(() => true, undefined, { revalidate: true });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Home</h1></div>
        <div className="page-head-actions">
          <button className="btn" onClick={refreshAll} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <Dashboard
        onCompose={() => router.push('/compose')}
        onEditDraft={(id) => router.push(`/compose?draft=${encodeURIComponent(id)}`)}
      />
    </>
  );
}
