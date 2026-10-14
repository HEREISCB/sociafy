'use client';

import { useEffect, useState } from 'react';
import { SignIn, ClerkLoading, ClerkLoaded } from '@clerk/nextjs';
import Link from 'next/link';
import { AuthLoading } from '../../../../components/auth-loading';
import { safeNextPath } from '../../../../lib/safe-next';

/**
 * Free-try visitors sign up to unlock a blurred result; send them back to it
 * instead of onboarding. Only /try-* and /free-* paths on this site, so this is never an open redirect.
 * Read from location (not useSearchParams): this only renders inside
 * ClerkLoaded, which is client-only, so there is no server pass to mismatch.
 */
function tryReturn(): string | null {
  if (typeof window === 'undefined') return null;
  const next = new URLSearchParams(window.location.search).get('redirect_url');
  return next && /^\/(try-(image|video)|free-[a-z0-9-]{3,60})(\?id=[0-9a-f-]{36}(&download=1)?)?$/.test(next) ? next : null;
}

/** In-app "Sign in" links pass ?next=<path> (e.g. /onboarding); honour it, same-site only. */
function nextReturn(): string {
  if (typeof window === 'undefined') return '/dashboard';
  return safeNextPath(new URLSearchParams(window.location.search).get('next'), '/dashboard');
}

const PLAN_NAMES: Record<string, string> = { starter: 'Starter', pro: 'Pro', business: 'Business' };

export default function Page() {
  // After mount only: the server render has no query string to read.
  const [plan, setPlan] = useState<string | null>(null);
  useEffect(() => {
    const tier = nextReturn().match(/^\/settings\/plan\?tier=(\w+)/)?.[1];
    if (tier && PLAN_NAMES[tier]) setPlan(PLAN_NAMES[tier]);
  }, []);

  return (
    <div className="auth-shell">
      <div className="auth-stack">
        <Link href="/" className="auth-brand" aria-label="Sociafy home">
          <div className="brand-mark" aria-hidden="true">S</div>
          <span className="brand-name">Sociafy<span className="dot">.</span></span>
        </Link>
        <div className="auth-head">
          <h1>Welcome back</h1>
          <p>{plan ? `Log in to check out for the ${plan} plan.` : 'Log in with Google or your email.'}</p>
        </div>
        <ClerkLoading>
          <AuthLoading />
        </ClerkLoading>
        <ClerkLoaded>
          <SignIn
            appearance={{
              elements: {
                rootBox: { width: '100%' },
                card: { background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'none', borderRadius: 'var(--r)' },
              },
            }}
            signUpUrl="/sign-up"
            forceRedirectUrl={tryReturn() ?? nextReturn()}
          />
        </ClerkLoaded>
      </div>
    </div>
  );
}
