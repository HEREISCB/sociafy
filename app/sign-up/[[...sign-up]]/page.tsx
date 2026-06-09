'use client';

import { SignUp, ClerkLoading, ClerkLoaded } from '@clerk/nextjs';
import Link from 'next/link';
import { AuthLoading } from '../../../components/auth-loading';

export default function Page() {
  return (
    <div className="auth-shell">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
        <Link href="/" className="auth-brand" aria-label="Sociafy home">
          <div className="brand-mark" aria-hidden="true">S</div>
          <span className="brand-name">Sociafy<span className="dot">.</span></span>
        </Link>
        <div style={{ textAlign: 'center', maxWidth: 380 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>
            Create your workspace
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--ink-3, #71717a)', lineHeight: 1.5 }}>
            10 seconds with Google. No credit card. Cancel anytime.
          </p>
        </div>
        <ClerkLoading>
          <AuthLoading />
        </ClerkLoading>
        <ClerkLoaded>
          <SignUp
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
            signInUrl="/sign-in"
            forceRedirectUrl="/onboarding"
          />
        </ClerkLoaded>
      </div>
    </div>
  );
}
