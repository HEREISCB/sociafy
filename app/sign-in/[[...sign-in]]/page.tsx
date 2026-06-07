'use client';

import { SignIn, ClerkLoading, ClerkLoaded } from '@clerk/nextjs';
import Link from 'next/link';
import { AuthLoading } from '../../../components/auth-loading';

export default function Page() {
  return (
    <div className="auth-shell">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
        <Link href="/" className="auth-brand" aria-label="Sociafy home">
          <div className="brand-mark" aria-hidden="true">S</div>
          <span className="brand-name">Sociafy<span className="dot">.</span></span>
        </Link>
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
            forceRedirectUrl="/dashboard"
          />
        </ClerkLoaded>
      </div>
    </div>
  );
}
