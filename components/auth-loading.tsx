'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Empty, Seg, Skeleton } from './ui';

/**
 * Shown while Clerk's frontend bundle initializes on the auth pages: a
 * skeleton the size of Clerk's form, so nothing jumps when it arrives. If it
 * takes too long it usually means the auth provider's script is being blocked
 * (privacy browsers / shields / ad-blockers) or the instance isn't reachable,
 * so after 8s we swap to a self-help message instead of an endless shimmer.
 */
export function AuthLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="auth-loading" role="status" aria-label={slow ? undefined : 'Loading sign-in'}>
      {slow ? (
        <Empty
          icon="alert"
          title="Sign-in is taking longer than usual"
          action={<button type="button" className="btn primary" onClick={() => window.location.reload()}>Reload</button>}
        >
          A privacy browser or ad blocker can stop it loading. Pause it for sociafy.app, or try another browser.
          Still stuck? <a href="mailto:support@sociafy.app">support@sociafy.app</a>
        </Empty>
      ) : (
        <>
          <Skeleton h={40} />
          <Skeleton h={12} w="30%" style={{ justifySelf: 'center' }} />
          <Skeleton h={14} w="25%" />
          <Skeleton h={40} />
          <Skeleton h={40} />
          <Skeleton h={14} w="55%" style={{ justifySelf: 'center', marginTop: 28 }} />
        </>
      )}
    </div>
  );
}

/** Log in | Create account, so a visitor on the wrong page switches in one tap. Keeps the query (?next, redirect_url). */
export function AuthTabs({ active }: { active: 'in' | 'up' }) {
  const router = useRouter();
  return (
    <Seg
      className="auth-tabs full"
      value={active}
      label="Account"
      options={[{ id: 'in', label: 'Log in' }, { id: 'up', label: 'Create account' }]}
      onChange={(v) => { if (v !== active) router.replace(`${v === 'in' ? '/sign-in' : '/sign-up'}${window.location.search}`); }}
    />
  );
}
