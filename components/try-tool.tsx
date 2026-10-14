'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { TryView } from '../lib/try';
import { PostedForYou } from './text-tool';
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
      ? <img src={src} alt={gen?.prompt ?? ''} className="tool-media" />
      : <video src={src} autoPlay loop muted playsInline controls className="tool-media" />;

  return (
    <div className="card tool-card">
      <form onSubmit={submit}>
        <label htmlFor="try-prompt" className="tool-label">Describe the {kind} you want</label>
        <textarea
          id="try-prompt"
          className="input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={600}
          rows={3}
          placeholder={ideas[0]}
        />
        <div className="tool-chips">
          {ideas.map((ex) => (
            <button type="button" key={ex} className="prompt-chip" onClick={() => setPrompt(ex)}>{ex}</button>
          ))}
        </div>
        <div className="tool-submit">
          <button className="btn btn-lg primary" type="submit" disabled={busy || gen?.status === 'pending' || prompt.trim().length < 3 || (turnstileRequired && !token)}>
            {busy ? 'Starting…' : `Generate ${kind}`}
          </button>
          <span className="tool-hint">Free to try. No account needed.</span>
        </div>
        <Turnstile onToken={setToken} resetKey={attempt} />
      </form>

      {error && <p role="alert" className="tool-error">{error} {error.includes('account') && <Link href="/sign-up">Sign up</Link>}</p>}

      {gen && (
        <div className="tool-output" aria-live="polite">
          {gen.status === 'pending' && (
            <div className="tool-wait">
              <p>Generating your {kind}, {WAIT[kind]}{elapsed > 0 ? ` · ${elapsed}s` : ''}…</p>
              <p className="tool-hint">
                You can leave this page. Your {kind} keeps rendering and waits at this link.{' '}
                <button type="button" className="prompt-chip" onClick={() => { void navigator.clipboard?.writeText(window.location.href); setCopied(true); }}>
                  {copied ? 'Link copied' : 'Copy link'}
                </button>
              </p>
              <p className="tool-hint">Made with this tool:</p>
              {kind === 'image'
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={SAMPLES.image} alt="Example AI image made with Sociafy" loading="lazy" className="tool-sample" />
                : <video src={SAMPLES.video} autoPlay loop muted playsInline preload="metadata" className="tool-sample" />}
            </div>
          )}
          {gen.status === 'failed' && (
            <p className="tool-wait">{gen.error ?? 'That one didn’t work.'} Try another prompt, this did not use up your free try.</p>
          )}
          {gen.status === 'ready' && gen.unlocked && gen.url && (
            <>
              {media(gen.url)}
              <div className="tool-submit">
                <a className="btn btn-lg primary" href={`/api/try/${gen.id}/download`}>Download HD</a>
                <span className="tool-hint">Saved to your media library.</span>
              </div>
              <PostedForYou />
            </>
          )}
          {gen.status === 'ready' && !gen.unlocked && (
            <>
              {gen.previewUrl ? media(gen.previewUrl) : <p className="tool-wait">Your {kind} is ready.</p>}
              <div className="tool-submit">
                <a className="btn btn-lg primary" href={unlockHref}>Download HD, no watermark</a>
                <span className="tool-hint">
                  Sign up and the clean {kind} downloads straight away. Have an account?{' '}
                  <a href={`/sign-in?redirect_url=${back}`}>Log in</a>
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
