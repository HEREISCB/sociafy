'use client';

import { SignIn, ClerkLoading, ClerkLoaded } from '@clerk/nextjs';
import Link from 'next/link';
import { AuthLoading } from '../../../components/auth-loading';

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

export default function Page() {
  return (
    <div className="auth-shell">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
        <Link href="/" className="auth-brand" aria-label="Sociafy home">
          <div className="brand-mark" aria-hidden="true">S</div>
          <span className="brand-name">Sociafy<span className="dot">.</span></span>
        </Link>
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>
            Welcome back
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--ink-3, #71717a)', lineHeight: 1.5 }}>
            Continue with Google or your email — same workspace either way.
          </p>
        </div>
        <ClerkLoading>
          <AuthLoading />
        </ClerkLoading>
        <ClerkLoaded>
          <SignIn
            appearance={{
              elements: {
                rootBox: { width: '100%' },
                card: {
                  background: 'var(--bg-elev, #fff)',
                  border: '1px solid var(--line, #eaeaea)',
                  boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 24px 60px -24px rgba(0,0,0,0.12)',
                  borderRadius: 18,
                },
              },
            }}
            signUpUrl="/sign-up"
            forceRedirectUrl={tryReturn() ?? '/dashboard'}
          />
        </ClerkLoaded>
      </div>
    </div>
  );
}
