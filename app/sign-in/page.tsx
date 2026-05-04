'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSupabaseBrowser } from '../../lib/supabase/client';

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const supabase = getSupabaseBrowser();
  const stub = !supabase;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (stub) {
      router.push(next);
      return;
    }
    setBusy(true);
    const { error } = await supabase!.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function oauth(provider: 'google' | 'github') {
    if (stub) {
      router.push(next);
      return;
    }
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    await supabase!.auth.signInWithOAuth({ provider, options: { redirectTo } });
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Link href="/" className="auth-brand">
          <div className="brand-mark">S</div>
          <span className="brand-name">sociafy<span className="dot">.</span></span>
        </Link>
        <h1 className="auth-h1">Welcome back</h1>
        <p className="auth-sub">Sign in to your workspace.</p>

        {stub && (
          <div className="auth-stub">
            Supabase isn&apos;t configured — sign-in is in stub mode and will land you in the dashboard.
          </div>
        )}

        <div className="auth-oauth">
          <button className="btn auth-oauth-btn" onClick={() => oauth('google')}>Continue with Google</button>
          <button className="btn auth-oauth-btn" onClick={() => oauth('github')}>Continue with GitHub</button>
        </div>

        <div className="auth-divider"><span>or</span></div>

        <form onSubmit={onSubmit} className="auth-form">
          <label className="auth-field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {err && <div className="auth-err">{err}</div>}
          <button className="btn primary auth-submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="auth-foot">
          New here? <Link href="/sign-up">Create account</Link>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="auth-shell" />}>
      <SignInForm />
    </Suspense>
  );
}
