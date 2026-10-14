'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import Compose from '../../../../components/compose';

export default function ComposePage({ searchParams }: { searchParams: Promise<{ draft?: string | string[] }> }) {
  const router = useRouter();
  const { draft } = use(searchParams);
  const draftId = typeof draft === 'string' && draft ? draft : null;
  return (
    <>
      <div className="page-head">
        <div><h1>{draftId ? 'Edit post' : 'New post'}</h1></div>
      </div>
      {/* Keyed so "New post" while editing a draft starts from a clean slate. */}
      <Compose key={draftId ?? 'new'} draftId={draftId} onDone={() => router.push('/dashboard')} />
    </>
  );
}
