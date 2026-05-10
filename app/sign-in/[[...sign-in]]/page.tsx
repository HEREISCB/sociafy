'use client';

import { SignIn } from '@clerk/nextjs';
import Link from 'next/link';

export default function Page() {
  return (
    <div className="auth-shell">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
        <Link href="/" className="auth-brand">
          <div className="brand-mark">S</div>
          <span className="brand-name">sociafy<span className="dot">.</span></span>
        </Link>
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
      </div>
    </div>
  );
}
