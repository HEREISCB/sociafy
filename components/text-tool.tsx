'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Turnstile, turnstileRequired } from './turnstile';
import { FREE_TONES, type FreeToolId } from '../lib/free-tools';

type Props = { tool: FreeToolId; label: string; examples: string[]; cta: string };

/** The one pitch on a tool page, shown only once there is a result. */
export function PostedForYou() {
  return (
    <div className="tool-upsell">
      <p>Want this posted for you every week?</p>
      <Link className="btn" href="/sign-up">Get started</Link>
    </div>
  );
}

export function TextTool({ tool, label, examples, cta }: Props) {
  const [input, setInput] = useState('');
  const [tone, setTone] = useState<string | null>(null);
  const [results, setResults] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [runs, setRuns] = useState(0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (input.trim().length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/free-tools', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, input, tone: tone ?? undefined, turnstileToken: token }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) setError(body.hint ?? 'Something went wrong. Try again.');
      else setResults(body.results ?? []);
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
      setRuns((n) => n + 1); // Turnstile tokens are single-use.
    }
  }

  async function copy(text: string, i: number) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(i);
    setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500);
  }

  return (
    <div className="card tool-card">
      <form onSubmit={submit}>
        <label htmlFor="tool-input" className="tool-label">{label}</label>
        <textarea
          id="tool-input"
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={1500}
          rows={4}
          placeholder={examples[0]}
        />
        <div className="tool-chips">
          {examples.map((ex) => (
            <button type="button" key={ex} className="prompt-chip" onClick={() => setInput(ex)}>{ex}</button>
          ))}
        </div>
        <div role="group" aria-label="Tone" className="tool-chips">
          <span className="tool-hint">Tone (optional)</span>
          {FREE_TONES.map((t) => (
            <button
              type="button"
              key={t}
              className={`prompt-chip tool-tone${tone === t ? ' active' : ''}`}
              aria-pressed={tone === t}
              onClick={() => setTone(tone === t ? null : t)}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="tool-submit">
          <button className="btn btn-lg primary" type="submit" disabled={busy || input.trim().length < 3 || (turnstileRequired && !token)}>
            {busy ? 'Writing…' : results.length ? 'Generate again' : cta}
          </button>
          <span className="tool-hint">Free. No account needed.</span>
        </div>
        <Turnstile onToken={setToken} resetKey={runs} />
      </form>

      {error && (
        <p role="alert" className="tool-error">
          {error} {error.includes('sign up') && <Link href="/sign-up">Sign up</Link>}
        </p>
      )}

      <div aria-live="polite">
        {results.length > 0 && (
          <>
            <ol className="tool-results">
              {results.map((r, i) => (
                <li key={`${i}-${r.slice(0, 20)}`}>
                  <p>{r}</p>
                  <button type="button" className="btn" onClick={() => copy(r, i)}>
                    {copied === i ? 'Copied' : 'Copy'}
                  </button>
                </li>
              ))}
            </ol>
            <PostedForYou />
          </>
        )}
      </div>
    </div>
  );
}
