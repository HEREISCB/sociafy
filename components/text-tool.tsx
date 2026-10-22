'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Turnstile, turnstileRequired } from './turnstile';
import { FREE_TONES, FREE_TOOLS, FREE_TEXT_PER_HOUR, type FreeToolId } from '../lib/free-tools';
import { tierPriceView } from '../lib/billing/pricing';
import { CREDIT_PRICES } from '../lib/credits/pricing';

type Props = { tool: FreeToolId; label: string; examples: string[]; cta: string };

const FROM = tierPriceView('INR', 'starter').display;

/** The one pitch on a tool page, after there is a result. `back` is where sign-up returns to. */
export function Upsell({ back, kept }: { back: string; kept: string }) {
  return (
    <div className="tp-upsell">
      <b>Want these made in your voice and posted for you?</b>
      <p>Sociafy learns how you write, makes the images and schedules the month. {kept} Plans from <span className="mono">{FROM}</span>/mo.</p>
      <div className="lp-cta">
        <Link className="btn primary lp-pill" href={`/sign-up?redirect_url=${encodeURIComponent(back)}`}>Get started</Link>
        <Link className="btn lp-pill lp-ghost" href="/#how">How it works</Link>
      </div>
    </div>
  );
}

/** A short confirmation pill ("Caption copied"). Area-local; to replace with ui.tsx's toast once public pages mount its provider. */
export function useFlash() {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flash = (m: string) => {
    setMsg(m);
    clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(null), 1800);
  };
  const node = <div className="tp-toast" role="status" data-on={msg ? '' : undefined}>{msg}</div>;
  return [flash, node] as const;
}

/** m:ss */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Ticks once a second while `on`, from the moment it turned on. */
export function useElapsed(on: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t0 = Date.now();
    setS(0);
    const t = setInterval(() => setS(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [on]);
  return s;
}

type Saved = { input: string; tone: string | null; results: string[]; at: number };
const KEY = (tool: string) => `sfy-free:${tool}`;
const WEEK = 7 * 24 * 60 * 60 * 1000;

export function TextTool({ tool, label, examples, cta }: Props) {
  const meta = FREE_TOOLS[tool];
  const [input, setInput] = useState('');
  const [tone, setTone] = useState<string | null>(null);
  const [results, setResults] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When the hourly free limit lifts (from the 429's retryAfterMin). */
  const [limitUntil, setLimitUntil] = useState(0);
  const [token, setToken] = useState<string | null>(null);
  const [runs, setRuns] = useState(0);
  const [now, setNow] = useState(0);
  const [flash, toast] = useFlash();
  const elapsed = useElapsed(busy);

  // Results survive sign-up: kept in this browser, restored when the visitor
  // comes back to this page (sign-up returns here via redirect_url).
  useEffect(() => {
    try {
      const s: Saved | null = JSON.parse(localStorage.getItem(KEY(tool)) ?? 'null');
      if (!s || Date.now() - s.at > WEEK) return;
      setInput(s.input);
      setTone(s.tone);
      setResults(s.results);
    } catch { /* private mode or bad JSON: start empty */ }
  }, [tool]);

  // Keep the countdown honest while limited.
  useEffect(() => {
    if (!limitUntil) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [limitUntil]);
  const limitMin = limitUntil > now ? Math.ceil((limitUntil - now) / 60_000) : 0;

  const n = input.trim().length;
  const why = busy ? 'Writing…'
    : limitMin ? `Free limit reached. Try again in ${limitMin} min.`
      : n < 3 ? 'Describe it first (3+ characters).'
        : turnstileRequired && !token ? 'Running a quick bot check…'
          : results.length ? 'Edit the brief or run it again.' : 'Ready.';
  const blocked = busy || !!limitMin || n < 3 || (turnstileRequired && !token);
  const label2 = busy ? 'Writing…' : results.length ? 'Run it again' : cta;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/free-tools', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, input, tone: tone ?? undefined, turnstileToken: token }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 429) {
        setLimitUntil(Date.now() + (Number(body.retryAfterMin) || 60) * 60_000);
      } else if (!r.ok) {
        setError(body.hint ?? 'Something went wrong. Try again.');
      } else {
        const list: string[] = body.results ?? [];
        setResults(list);
        try { localStorage.setItem(KEY(tool), JSON.stringify({ input, tone, results: list, at: Date.now() } satisfies Saved)); } catch { /* full */ }
      }
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
      setRuns((k) => k + 1); // Turnstile tokens are single-use.
    }
  }

  const copy = (text: string, msg: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    flash(msg);
  };
  const one = meta.noun.replace(/s$/, '');
  const tag = (i: number) => meta.labels?.[i] ?? String(i + 1);

  return (
    <>
      <div className="tp-tool">
        <form id="tp-form" className="card tp-in" onSubmit={submit}>
          <div className="field">
            <div className="field-head">
              <label htmlFor="tool-input">{label}</label>
              <span className="field-note mono">{input.length.toLocaleString('en-US')} / 1,500</span>
            </div>
            <textarea
              id="tool-input"
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={1500}
              rows={4}
              placeholder={meta.placeholder}
            />
          </div>
          <div className="field">
            <div className="field-head"><b>Or start from an example</b><span className="field-note">Tap to fill</span></div>
            <div className="tp-chips">
              {examples.map((ex) => (
                <button type="button" key={ex} className="prompt-chip" onClick={() => setInput(ex)}>{ex}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <div className="field-head"><b id="tone-l">Tone</b><span className="field-note">Optional</span></div>
            <div role="group" aria-labelledby="tone-l" className="tp-chips">
              {FREE_TONES.map((t) => (
                <button type="button" key={t} className="chip tp-tone" aria-pressed={tone === t} onClick={() => setTone(tone === t ? null : t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="tp-run">
            <span className="why" aria-live="polite">{why}</span>
            <button className="btn primary lg lp-pill" type="submit" disabled={blocked}>{label2}</button>
          </div>
          <p className="tp-note">
            Free, no account. {FREE_TEXT_PER_HOUR} runs an hour. Protected by Cloudflare; a check only appears if it is unsure.
          </p>
          <div className="tp-turnstile"><Turnstile onToken={setToken} resetKey={runs} /></div>
        </form>

        <section className="card tp-out" aria-label={`Your ${meta.noun}`} aria-busy={busy || undefined}>
          {busy ? (
            <>
              <div className="tp-ohead">Writing…<span className="mono tp-timer">{clock(elapsed)}</span></div>
              <Ghosts n={3} />
            </>
          ) : limitMin ? (
            <>
              <div className="tp-ohead">Your {meta.noun}</div>
              <p className="tp-err" role="alert">You have used the {FREE_TEXT_PER_HOUR} free runs for this hour. Try again in {limitMin} min. Your brief is kept.</p>
              <div className="tp-upsell">
                <b>Need more today?</b>
                <p>Plans include 2,000+ credits a month. A text post costs <span className="mono">{CREDIT_PRICES.text_post} cr</span>.</p>
                <div className="lp-cta"><Link className="btn primary lp-pill" href="/#pricing">See plans</Link></div>
              </div>
            </>
          ) : results.length ? (
            <>
              <div className="tp-ohead">
                <span><span className="mono">{results.length}</span> {meta.noun}</span>
                <button type="button" className="btn sm lp-pill" onClick={() => copy(results.join('\n\n'), `All ${results.length} copied`)}>Copy all</button>
              </div>
              {error && <p className="tp-err" role="alert">{error}</p>}
              <ol className="tp-res">
                {results.map((r, i) => (
                  <li key={`${i}-${r.slice(0, 20)}`} className="develop" style={{ animationDelay: `${i * 90}ms` }}>
                    <span className="tp-k">{tag(i)}</span>
                    <p>{r}</p>
                    <button type="button" className="btn ghost sm" aria-label={`Copy ${one} ${i + 1}`} onClick={() => copy(r, `${one[0].toUpperCase()}${one.slice(1)} copied`)}>Copy</button>
                  </li>
                ))}
              </ol>
              <Upsell back={meta.slug} kept={`Your ${meta.noun} stay here if you sign up.`} />
            </>
          ) : (
            <>
              <div className="tp-ohead">Your {meta.noun}<span className="field-note">Appear here</span></div>
              {error && <p className="tp-err" role="alert">{error}</p>}
              <Ghosts n={3} />
              <p className="tp-note">{meta.makes} develop here, usually within seconds.</p>
            </>
          )}
        </section>
      </div>
      {/* Phones: the run button stays reachable under the keyboard-height form. */}
      <div className="tp-bar">
        <span className="why">{why}</span>
        <button className="btn primary lp-pill" type="submit" form="tp-form" disabled={blocked}>{label2}</button>
      </div>
      {toast}
    </>
  );
}

const Ghosts = ({ n }: { n: number }) => (
  <div className="tp-ghosts" aria-hidden="true">
    {Array.from({ length: n }, (_, i) => <div key={i}><i style={{ width: `${92 - i * 11}%` }} /><i style={{ width: `${62 - i * 9}%` }} /></div>)}
  </div>
);
