'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Turnstile, turnstileRequired } from './turnstile';
import { FREE_TONES, type FreeToolId } from '../lib/free-tools';

type Props = { tool: FreeToolId; label: string; examples: string[]; cta: string };

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
    <div className="card" style={{ padding: 20, maxWidth: 720, margin: '0 auto', textAlign: 'left' }}>
      <form onSubmit={submit}>
        <label htmlFor="tool-input" style={{ fontSize: 13, fontWeight: 550, display: 'block', marginBottom: 8 }}>{label}</label>
        <textarea
          id="tool-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={1500}
          rows={4}
          placeholder={examples[0]}
          style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--line-2)', background: 'var(--bg)', color: 'var(--ink)', font: 'inherit', fontSize: 15, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
          {examples.map((ex) => (
            <button type="button" key={ex} className="prompt-chip" onClick={() => setInput(ex)}>{ex}</button>
          ))}
        </div>
        <div role="group" aria-label="Tone" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '0 0 14px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)', marginRight: 4 }}>Tone (optional):</span>
          {FREE_TONES.map((t) => (
            <button
              type="button"
              key={t}
              className={`prompt-chip${tone === t ? ' active' : ''}`}
              aria-pressed={tone === t}
              onClick={() => setTone(tone === t ? null : t)}
              style={{ textTransform: 'capitalize' }}
            >
              {t}
            </button>
          ))}
        </div>
        <button className="btn btn-lg primary" type="submit" disabled={busy || input.trim().length < 3 || (turnstileRequired && !token)}>
          {busy ? 'Writing…' : results.length ? 'Generate again' : cta}
        </button>
        <span style={{ marginLeft: 12, fontSize: 12.5, color: 'var(--ink-3)' }}>Free. No account needed.</span>
        <Turnstile onToken={setToken} resetKey={runs} />
      </form>

      {error && (
        <p role="alert" style={{ marginTop: 14, color: 'var(--bad, #c0392b)', fontSize: 13.5 }}>
          {error} {error.includes('sign up') && <Link href="/sign-up" style={{ textDecoration: 'underline' }}>Sign up free</Link>}
        </p>
      )}

      <div aria-live="polite">
        {results.length > 0 && (
          <>
            <ol style={{ listStyle: 'none', padding: 0, margin: '20px 0 0', display: 'grid', gap: 10 }}>
              {results.map((r, i) => (
                <li key={`${i}-${r.slice(0, 20)}`} style={{ padding: 14, background: 'var(--bg-sunk)', borderRadius: 12, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <p style={{ margin: 0, flex: 1, whiteSpace: 'pre-wrap', fontSize: 14.5, lineHeight: 1.5 }}>{r}</p>
                  <button type="button" className="btn" onClick={() => copy(r, i)} style={{ flexShrink: 0 }}>
                    {copied === i ? 'Copied' : 'Copy'}
                  </button>
                </li>
              ))}
            </ol>
            <p style={{ marginTop: 16, fontSize: 14, color: 'var(--ink-3)' }}>
              Want this written in your voice and posted for you? Sociafy&apos;s autopilot does it every day.{' '}
              <Link href="/sign-up" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>Try it free</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
