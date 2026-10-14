'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import Compose from '../../../../components/compose';

type Params = { draft?: string | string[]; prompt?: string | string[]; slot?: string | string[]; platforms?: string | string[] };
const one = (v: string | string[] | undefined) => (typeof v === 'string' && v ? v : undefined);

export default function ComposePage({ searchParams }: { searchParams: Promise<Params> }) {
  const router = useRouter();
  const sp = use(searchParams);
  const draftId = one(sp.draft) ?? null;
  const initial = { prompt: one(sp.prompt), slot: one(sp.slot), platforms: one(sp.platforms) };
  return (
    <>
      <div className="page-header">
        <h1>{draftId ? 'Edit post' : 'New post'}</h1>
      </div>
      {/* Keyed so "New post" while editing a draft, or a new slot, starts clean. */}
      <Compose key={draftId ?? `new-${initial.slot ?? ''}`} draftId={draftId} initial={initial} onDone={() => router.push('/dashboard')} />
    </>
  );
}
