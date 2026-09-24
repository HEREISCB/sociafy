'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { TryView } from '../lib/try';
import { Turnstile, turnstileRequired } from './turnstile';

type Kind = 'image' | 'video';

const EXAMPLES: Record<Kind, string[]> = {
  image: [
    'A cozy coffee shop at golden hour, film photo',
    'Minimal product shot of white sneakers on a pastel background',
    'Founder working late in a neon-lit home office, cinematic',
  ],
  video: [
    'Slow drone shot over a misty forest at sunrise',
    'Steaming latte being poured in slow motion, close up',
    'A paper plane flying through a sunny city street',
  ],
};

const WAIT: Record<Kind, string> = { image: 'usually 20–40 seconds', video: 'usually 1–3 minutes' };

// Real results from this tool, watermarked like a visitor's would be.
const SAMPLES: Record<Kind, string> = {
  image: 'https://pub-b8668a9ec26147f9bd19ea2e55fee67f.r2.dev/try/ea08c80a-dbbd-4a5c-854b-4ee37acb7bd2/preview.jpg',
  video: 'https://pub-b8668a9ec26147f9bd19ea2e55fee67f.r2.dev/try/a16d20e7-120e-4273-88f5-18dfa202a252/preview.mp4',
};

type Props = {
  kind: Kind;
  /** This page's URL: sign-up returns here. */
  path?: string;
  /** Output shape, see lib/try-presets. Default square / 9:16. */
  aspect?: string;
  examples?: string[];
};

export function TryTool({ kind, path: pagePath, aspect, examples }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [gen, setGen] = useState<TryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);

  const path = pagePath ?? (kind === 'image' ? '/try-image' : '/try-video');
  const ideas = examples ?? EXAMPLES[kind];

  const load = useCallback(async (id: string) => {
    const r = await fetch(`/api/try/${id}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const v: TryView = await r.json();
    setGen(v);
    return v;
  }, []);

  // Coming back from sign-up lands on ?id=…&download=1 — pick the generation
  // back up and, once it is theirs, start the clean download by itself.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get('id');
    if (!id) return;
    started.current = Date.now();
    void Promise.resolve().then(() => load(id)).then((v) => {
      if (q.get('download') !== '1' || !v?.unlocked || !v.url) return;
      window.history.replaceState(null, '', `${path}?id=${id}`);
      window.location.assign(`/api/try/${id}/download`);
    });
  }, [load, path]);

  // Poll while it renders.
  useEffect(() => {
    if (gen?.status !== 'pending') return;
    const t = setInterval(() => {
      setElapsed(Math.round((Date.now() - started.current) / 1000));
      load(gen.id);
    }, kind === 'image' ? 3000 : 6000);
    return () => clearInterval(t);
  }, [gen?.status, gen?.id, kind, load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (prompt.trim().length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/try', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, prompt, aspect, turnstileToken: token ?? undefined }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.hint ?? 'Something went wrong. Try again.');
        return;
      }
      started.current = Date.now();
      setElapsed(0);
      setGen(body);
      window.history.replaceState(null, '', `${path}?id=${body.id}`);
    } finally {
      setBusy(false);
      setAttempt((n) => n + 1); // Turnstile tokens are single-use.
    }
  }

  // Both routes back carry download=1, so the clean file downloads the moment they return.
  const back = gen ? encodeURIComponent(`${path}?id=${gen.id}&download=1`) : '';
  const unlockHref = gen ? `/sign-up?redirect_url=${back}` : '/sign-up';
  const media = (src: string) =>
    kind === 'image'
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={src} alt={gen?.prompt ?? ''} style={{ width: '100%', display: 'block', borderRadius: 12 }} />
      : <video src={src} autoPlay loop muted playsInline controls style={{ width: '100%', maxHeight: 560, display: 'block', borderRadius: 12, background: '#000' }} />;

  return (
    <div className="card" style={{ padding: 20, maxWidth: 720, margin: '0 auto', textAlign: 'left' }}>
      <form onSubmit={submit}>
        <label htmlFor="try-prompt" style={{ fontSize: 13, fontWeight: 550, display: 'block', marginBottom: 8 }}>
          Describe the {kind} you want
        </label>
        <textarea
          id="try-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={600}
          rows={3}
          placeholder={ideas[0]}
          style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--line-2)', background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 15, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0 14px' }}>
          {ideas.map((ex) => (
            <button type="button" key={ex} className="prompt-chip" onClick={() => setPrompt(ex)}>{ex}</button>
          ))}
        </div>
        <button className="btn btn-lg primary" type="submit" disabled={busy || gen?.status === 'pending' || prompt.trim().length < 3 || (turnstileRequired && !token)}>
          {busy ? 'Starting…' : `Generate ${kind} free`}
        </button>
        <span style={{ marginLeft: 12, fontSize: 12.5, color: 'var(--ink-3)' }}>No card. No account needed to try.</span>
        <Turnstile onToken={setToken} resetKey={attempt} />
      </form>

      {error && <p role="alert" style={{ marginTop: 14, color: 'var(--bad, #c0392b)', fontSize: 13.5 }}>{error} {error.includes('account') && <Link href="/sign-up" style={{ textDecoration: 'underline' }}>Sign up free</Link>}</p>}

      {gen && (
        <div style={{ marginTop: 20 }} aria-live="polite">
          {gen.status === 'pending' && (
            <div style={{ padding: 24, textAlign: 'center', background: 'var(--bg-sunk)', borderRadius: 12, fontSize: 14 }}>
              <div>Generating your {kind}, {WAIT[kind]}{elapsed > 0 ? ` · ${elapsed}s` : ''}…</div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-3)', margin: '8px 0 14px' }}>
                You can leave this page. Your {kind} keeps rendering and waits at this link.{' '}
                <button type="button" className="prompt-chip" onClick={() => { void navigator.clipboard?.writeText(window.location.href); setCopied(true); }}>
                  {copied ? 'Link copied' : 'Copy link'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>Made with this tool:</div>
              {kind === 'image'
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={SAMPLES.image} alt="Example AI image made with Sociafy" loading="lazy" style={{ width: 220, borderRadius: 10 }} />
                : <video src={SAMPLES.video} autoPlay loop muted playsInline preload="metadata" style={{ width: 160, borderRadius: 10 }} />}
            </div>
          )}
          {gen.status === 'failed' && (
            <div style={{ padding: 20, background: 'var(--bg-sunk)', borderRadius: 12, fontSize: 14 }}>
              {gen.error ?? 'That one didn’t work.'} Try another prompt, this did not use up your free try.
            </div>
          )}
          {gen.status === 'ready' && gen.unlocked && gen.url && (
            <div>
              {media(gen.url)}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <a className="btn btn-lg primary" href={`/api/try/${gen.id}/download`}>Download HD</a>
                <a className="btn btn-lg" href="/dashboard?tab=compose">Post it with Sociafy</a>
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 8 }}>Saved to your media library.</p>
              <div className="card" style={{ marginTop: 14, padding: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontWeight: 600, fontSize: 14.5 }}>Next: let Sociafy post for you</div>
                  <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>Two minutes of setup. Pick your niches and platforms, and autopilot drafts posts like this every week.</div>
                </div>
                <Link className="btn btn-lg primary" href="/onboarding">Set up your autopilot</Link>
              </div>
            </div>
          )}
          {gen.status === 'ready' && !gen.unlocked && (
            <div>
              {gen.previewUrl
                ? media(gen.previewUrl)
                : <div style={{ padding: 32, textAlign: 'center', background: 'var(--bg-sunk)', borderRadius: 12, fontSize: 14 }}>Your {kind} is ready.</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <a className="btn btn-lg primary" href={unlockHref}>Download HD, no watermark</a>
                <a className="btn btn-lg" href={unlockHref}>Remove watermark</a>
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 8 }}>
                Create a free Sociafy account and the clean {kind} downloads straight away. Already have one?{' '}
                <a href={`/sign-in?redirect_url=${back}`} style={{ textDecoration: 'underline' }}>Log in</a>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
