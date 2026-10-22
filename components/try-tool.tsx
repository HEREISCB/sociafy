'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { TryView } from '../lib/try';
import { SHAPE_LABEL, TRY_PER_DAY, TRY_WAIT, aspectRatio, type TryAspect } from '../lib/try-presets';
import { Upsell, clock, useElapsed, useFlash } from './text-tool';
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
const PLACEHOLDER: Record<Kind, string> = {
  image: 'e.g. a ceramic mug of chai on a rainy windowsill, soft light',
  video: 'e.g. waves rolling onto an empty beach at dawn, slow motion',
};

// Real results from this tool, watermarked like a visitor's would be.
const SAMPLES: Record<Kind, string> = {
  image: 'https://pub-b8668a9ec26147f9bd19ea2e55fee67f.r2.dev/try/ea08c80a-dbbd-4a5c-854b-4ee37acb7bd2/preview.jpg',
  video: 'https://pub-b8668a9ec26147f9bd19ea2e55fee67f.r2.dev/try/a16d20e7-120e-4273-88f5-18dfa202a252/preview.mp4',
};

/** The stages the server actually reports (lib/try tryPhase), then the browser loading the pixels. */
const PHASES: Record<Kind, [string, string][]> = {
  image: [['generating', 'Generating the image'], ['developing', 'Developing the preview']],
  video: [['queued', 'Queued'], ['generating', 'Rendering the video'], ['finalizing', 'Watermarking the preview'], ['developing', 'Developing the preview']],
};

/** The frame keeps the output's shape, capped in height so the action under it stays on screen. */
const frameStyle = (ratio: string): React.CSSProperties => {
  const [w, h] = ratio.split(' / ').map(Number);
  return { aspectRatio: ratio, maxWidth: `calc(min(400px, 50dvh) * ${w / h})` };
};

type Props = {
  kind: Kind;
  /** This page's URL: sign-up returns here. */
  path: string;
  /** Output shape, see lib/try-presets. */
  aspect: TryAspect;
  examples?: string[];
};

export function TryTool({ kind, path, aspect, examples }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [gen, setGen] = useState<TryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Free tries left today for this browser (GET /api/try/quota); null until known. */
  const [left, setLeft] = useState<number | null>(null);
  /** The preview's pixels have arrived; only then does it develop. */
  const [loaded, setLoaded] = useState(false);
  const [flash, toast] = useFlash();
  const started = useRef(0);
  const perDay = TRY_PER_DAY[kind];
  const ideas = examples ?? EXAMPLES[kind];
  const running = busy || gen?.status === 'pending' || (gen?.status === 'ready' && !loaded && !!(gen.url ?? gen.previewUrl));
  const elapsed = useElapsed(!!running);

  const load = useCallback(async (id: string) => {
    const r = await fetch(`/api/try/${id}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const v: TryView = await r.json();
    setGen(v);
    return v;
  }, []);

  const quota = useCallback(async () => {
    const r = await fetch(`/api/try/quota?kind=${kind}`, { cache: 'no-store' }).catch(() => null);
    if (r?.ok) setLeft((await r.json()).left);
  }, [kind]);

  useEffect(() => { void quota(); }, [quota]);

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
    const t = setInterval(() => load(gen.id), kind === 'image' ? 3000 : 6000);
    return () => clearInterval(t);
  }, [gen?.status, gen?.id, kind, load]);

  const n = prompt.trim().length;
  const out = left === 0 && gen?.status !== 'pending';
  const why = busy ? 'Starting…'
    : gen?.status === 'pending' ? `Your ${kind} is rendering.`
      : out ? `You have used today’s free ${kind}${perDay > 1 ? 's' : ''}. Come back tomorrow.`
        : n < 3 ? `Describe the ${kind} first (3+ characters).`
          : turnstileRequired && !token ? 'Running a quick bot check…'
            : gen ? 'Edit the prompt or make another.' : 'Ready.';
  const blocked = busy || gen?.status === 'pending' || out || n < 3 || (turnstileRequired && !token);
  const cta = busy ? 'Starting…' : `Generate ${kind}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/try', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, prompt, aspect, turnstileToken: token ?? undefined }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (body.error === 'try_limit') setLeft(0);
        setError(body.hint ?? 'Something went wrong. Try again.');
        return;
      }
      started.current = Date.now();
      setLoaded(false);
      setGen(body);
      setLeft((l) => (l == null ? l : Math.max(0, l - 1)));
      window.history.replaceState(null, '', `${path}?id=${body.id}`);
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
      setAttempt((k) => k + 1); // Turnstile tokens are single-use.
    }
  }

  // Both routes back carry download=1, so the clean file downloads the moment they return.
  const back = gen ? `${path}?id=${gen.id}&download=1` : path;
  const src = gen?.status === 'ready' ? (gen.unlocked && gen.url ? gen.url : gen.previewUrl) : null;
  const phase = gen?.status === 'pending' ? gen.phase ?? 'generating' : src && !loaded ? 'developing' : null;
  const steps = PHASES[kind];
  const at = steps.findIndex(([k]) => k === phase);
  const media = (url: string) =>
    kind === 'image'
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={url} alt={gen?.prompt ?? ''} className={loaded ? 'develop' : 'tp-unseen'} onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} />
      : <video src={url} autoPlay loop muted playsInline controls className={loaded ? 'develop' : 'tp-unseen'} onLoadedData={() => setLoaded(true)} onError={() => setLoaded(true)} />;

  return (
    <>
      <div className="tp-tool">
        <form id="tp-form" className="card tp-in" onSubmit={submit}>
          <div className="field">
            <div className="field-head">
              <label htmlFor="try-prompt">Describe the {kind} you want</label>
              <span className="field-note mono">{prompt.length} / 600</span>
            </div>
            <textarea id="try-prompt" className="input" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={600} rows={3} placeholder={PLACEHOLDER[kind]} />
          </div>
          <div className="field">
            <div className="field-head"><b>Or start from an example</b><span className="field-note">Tap to fill</span></div>
            <div className="tp-chips">
              {ideas.map((ex) => <button type="button" key={ex} className="prompt-chip" onClick={() => setPrompt(ex)}>{ex}</button>)}
            </div>
          </div>
          <div className="tp-run">
            <span className="why" aria-live="polite">{why}</span>
            <button className="btn primary lg lp-pill" type="submit" disabled={blocked}>{cta}</button>
          </div>
          <p className="tp-note">
            Free tool, no account needed: {perDay} {kind}{perDay > 1 ? 's' : ''} a day{/* Space held until the count arrives, so nothing below shifts. */}
            <span style={left == null ? { visibility: 'hidden' } : undefined}> · <span className="mono">{left ?? perDay} of {perDay}</span> left today</span>.
            Protected by Cloudflare; a check only appears if it is unsure.
          </p>
          <div className="tp-turnstile"><Turnstile onToken={setToken} resetKey={attempt} /></div>
        </form>

        <section className="card tp-out" aria-label={`Your ${kind}`} aria-busy={running || undefined}>
          <div className="tp-ohead">
            {phase ? <>Making your {kind}<span className="mono tp-timer">{clock(elapsed)}</span></> : <>Your {kind}<span className="field-note mono">{SHAPE_LABEL[aspect]}</span></>}
          </div>
          {error && <p className="tp-err" role="alert">{error} {/account|plan/.test(error) && <Link href="/#pricing">See plans</Link>}</p>}
          <div className="tp-frame" style={frameStyle(aspectRatio(kind, aspect))}>
            {!gen && (
              <>
                {kind === 'image'
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={SAMPLES.image} alt="Example AI image made with this tool" loading="lazy" />
                  : <video src={SAMPLES.video} autoPlay loop muted playsInline preload="metadata" aria-label="Example AI video made with this tool" />}
                <span className="badge tp-tag">Example</span>
              </>
            )}
            {src && media(src)}
            {phase && (
              <ol className="tp-phases">
                {steps.map(([k, l], i) => <li key={k} className={i < at ? 'is-done' : i === at ? 'is-now' : undefined}><i />{l}</li>)}
              </ol>
            )}
            {gen?.status === 'failed' && <p className="tp-frame-msg">{gen.error ?? 'That one didn’t work.'} Try another prompt; this did not use up your free {kind}.</p>}
            {gen?.status === 'ready' && !src && <p className="tp-frame-msg">Your {kind} is ready. Sign up to download it.</p>}
          </div>

          {!gen && <p className="tp-note">Your {kind} develops here, usually in {TRY_WAIT[kind].replace('~', 'about ')}. The example above was made with this tool.</p>}
          {gen?.status === 'pending' && (
            <p className="tp-note">
              You can leave this page. Your {kind} keeps rendering and waits at this link.{' '}
              <button type="button" className="btn sm lp-pill" onClick={() => { void navigator.clipboard?.writeText(window.location.href); flash('Link copied'); }}>Copy link</button>
            </p>
          )}
          {gen?.status === 'ready' && gen.unlocked && gen.url && (
            <>
              <div className="tp-run">
                <span className="why">Saved to your media library.</span>
                <a className="btn primary lg lp-pill" href={`/api/try/${gen.id}/download`}>Download HD</a>
              </div>
              <Upsell back={path} kept="" />
            </>
          )}
          {gen?.status === 'ready' && !gen.unlocked && (
            <div className="tp-run">
              <span className="why">
                Sign up and the clean {kind} downloads straight away. Have an account?{' '}
                <a href={`/sign-in?redirect_url=${encodeURIComponent(back)}`}>Log in</a>
              </span>
              <a className="btn primary lg lp-pill" href={`/sign-up?redirect_url=${encodeURIComponent(back)}`}>Download HD, no watermark</a>
            </div>
          )}
        </section>
      </div>
      <div className="tp-bar">
        <span className="why">{why}</span>
        <button className="btn primary lp-pill" type="submit" form="tp-form" disabled={blocked}>{cta}</button>
      </div>
      {toast}
    </>
  );
}
