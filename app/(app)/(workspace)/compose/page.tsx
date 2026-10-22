'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Compose from '../../../../components/compose';

type Params = { draft?: string | string[]; prompt?: string | string[]; slot?: string | string[]; platforms?: string | string[] };
const one = (v: string | string[] | undefined) => (typeof v === 'string' && v ? v : undefined);

export default function ComposePage({ searchParams }: { searchParams: Promise<Params> }) {
  const router = useRouter();
  const sp = use(searchParams);
  const draftId = one(sp.draft) ?? null;
  const initial = { prompt: one(sp.prompt), slot: one(sp.slot), platforms: one(sp.platforms) };
  /** "New post" after posting: a fresh composer even when the URL doesn't change. */
  const [round, setRound] = useState(0);
  return (
    // Keyed so "New post" while editing a draft, or a new slot, starts clean.
    <Compose
      key={`${draftId ?? `new-${initial.slot ?? ''}`}-${round}`}
      draftId={draftId}
      initial={initial}
      title={draftId ? 'Edit post' : 'New post'}
      onNew={() => {
        if (draftId || initial.prompt || initial.slot || initial.platforms) router.push('/compose');
        setRound((n) => n + 1);
      }}
    />
  );
}
