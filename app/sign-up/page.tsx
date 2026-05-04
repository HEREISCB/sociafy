'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '../../lib/supabase/client';

function SignUpForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);

  const supabase = getSupabaseBrowser();
  const stub = !supabase;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (stub) {
      router.push('/onboarding');
      return;
    }
    setBusy(true);
    const { error, data } = await supabase!.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: name },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/onboarding`,
      },
    });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    if (data.session) {
      router.push('/onboarding');
      router.refresh();
    } else {
      setConfirmSent(true);
    }
  }

  async function oauth(provider: 'google' | 'github') {
    if (stub) {
      router.push('/onboarding');
      return;
    }
    const redirectTo = `${window.location.origin}/auth/callback?next=/onboarding`;
    await supabase!.auth.signInWithOAuth({ provider, options: { redirectTo } });
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Link href="/" className="auth-brand">
          <div className="brand-mark">S</div>
          <span className="brand-name">sociafy<span className="dot">.</span></span>
        </Link>
        <h1 className="auth-h1">Create your workspace</h1>
        <p className="auth-sub">14 days free. No card. Cancel anytime.</p>

        {stub && (
          <div className="auth-stub">
            Supabase isn&apos;t configured — sign-up is in stub mode and will land you in onboarding.
          </div>
        )}

        {confirmSent ? (
          <div className="auth-confirm">
            Check your inbox at <b>{email}</b> to confirm your account, then sign in.
          </div>
        ) : (
          <>
            <div className="auth-oauth">
              <button className="btn auth-oauth-btn" onClick={() => oauth('google')}>Continue with Google</button>
              <button className="btn auth-oauth-btn" onClick={() => oauth('github')}>Continue with GitHub</button>
            </div>

            <div className="auth-divider"><span>or</span></div>

            <form onSubmit={onSubmit} className="auth-form">
              <label className="auth-field">
                <span>Your name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} required />
              </label>
              <label className="auth-field">
                <span>Email</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              <label className="auth-field">
                <span>Password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              </label>
              {err && <div className="auth-err">{err}</div>}
              <button className="btn primary auth-submit" type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create account'}
              </button>
            </form>
          </>
        )}

        <div className="auth-foot">
          Already a member? <Link href="/sign-in">Sign in</Link>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="auth-shell" />}>
      <SignUpForm />
    </Suspense>
  );
}
