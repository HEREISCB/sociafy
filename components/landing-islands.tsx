'use client';

// The few interactive bits of the public pages. Everything around them is
// server-rendered HTML; these hydrate on their own.

import React, { useEffect, useRef, useState } from 'react';
import { Seg } from './ui';
import { Icon } from './icons';
import { tierPriceView, topupLabel, type Currency } from '../lib/billing/pricing';
import { CREDIT_PRICES } from '../lib/credits/pricing';
import type { Tier } from '../lib/db/schema';

/** Guess the visitor's currency from their timezone (no network): India → INR, else USD. */
const detectCurrency = (): Currency => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'INR';
  } catch { /* unsupported */ }
  return 'USD';
};

/**
 * `initial` comes from the geo header, resolved on the server (app/page.tsx),
 * so prices are right in the first HTML. Null means no header (local dev, or a
 * host that doesn't geolocate): only then guess from the timezone.
 */
function useCurrency(initial: Currency | null) {
  const [c, setC] = useState<Currency>(initial ?? 'USD');
  useEffect(() => {
    if (!initial) setC(detectCurrency());
  }, [initial]);
  return [c, setC] as const;
}

export function HeroPrice({ initial }: { initial: Currency | null }) {
  const [c] = useCurrency(initial);
  return <b className="mono">{tierPriceView(c, 'starter').display}</b>;
}

const startCheckout = async (tier: Tier, setBusy: (t: Tier | null) => void) => {
  setBusy(tier);
  try {
    const r = await fetch('/api/billing/checkout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier }),
    });
    if (r.status === 401) {
      // Not signed in: sign up, then land on the plan page with this tier.
      window.location.href = `/sign-up?next=${encodeURIComponent(`/account/billing?tier=${tier}`)}`;
      return;
    }
    const data = await r.json().catch(() => ({} as { url?: string }));
    // No checkout URL means billing isn't configured; the plan page explains.
    window.location.href = data?.url ?? '/account/billing';
  } finally {
    setBusy(null);
  }
};

const TIERS: { tier: Tier; name: string; bullets: string[] }[] = [
  { tier: 'starter', name: 'Starter', bullets: ['All 6 platforms', 'Text, image & 720p video', 'You schedule every post'] },
  { tier: 'pro', name: 'Pro', bullets: ['Everything in Starter', 'Autopilot plans your posts', 'Web research on captions', 'Priority email support'] },
  { tier: 'business', name: 'Business', bullets: ['Everything in Pro', 'Autopilot with images and video', '1080p hero clips', 'Onboarding call'] },
];

/** Currency switch, the three plans and their checkout buttons. */
export function Pricing({ initial, credits }: { initial: Currency | null; credits: Record<Tier, number> }) {
  const [currency, setCurrency] = useCurrency(initial);
  const [busy, setBusy] = useState<Tier | null>(null);
  // The develop runs on a switch only, never on first paint.
  const [switched, setSwitched] = useState(false);
  const fig = (n: number) => n.toLocaleString('en-US');
  return (
    <>
      <div className="lp-phead" data-reveal>
        <div>
          <h2 id="pricing-h">Pricing</h2>
          <p className="lp-sub">Paid plans only. Cancel anytime, it ends with your billing cycle.</p>
        </div>
        <Seg
          label="Currency"
          value={currency}
          options={[{ id: 'INR', label: '₹ India' }, { id: 'USD', label: '$ Global' }]}
          onChange={(c) => { setSwitched(true); setCurrency(c); }}
        />
      </div>
      <div className="lp-prices">
        {TIERS.map(({ tier, name, bullets }, i) => {
          const v = tierPriceView(currency, tier);
          const n = credits[tier];
          return (
            <div className={`card lp-price${tier === 'pro' ? ' is-feat' : ''}`} key={tier} data-reveal={i ? i + 1 : ''}>
              <div className="lp-price-name">
                {name}
                {tier === 'pro' && <span className="badge accent">Most picked</span>}
              </div>
              <div className={`lp-amt${switched ? ' lp-reprint' : ''}`} key={currency}>
                <span className="mono">{v.display}</span><small> /mo</small>
              </div>
              {v.approximate && <p className="lp-billed">Billed as {v.charge} /mo</p>}
              <ul>
                <li>
                  <span className="mono">{fig(n)}</span> credits /mo · ~{Math.floor(n / CREDIT_PRICES.video_8s_720p_quality)} reels
                  or {fig(Math.floor(n / CREDIT_PRICES.image_medium_1024))} images
                </li>
                {bullets.map((b) => <li key={b}>{b}</li>)}
              </ul>
              <button
                type="button"
                className={`btn btn-lg lp-pill${tier === 'pro' ? ' primary' : ''}`}
                onClick={() => startCheckout(tier, setBusy)}
                disabled={busy !== null}
              >
                {busy === tier ? 'Redirecting…' : `Choose ${name}`}
              </button>
            </div>
          );
        })}
      </div>
      <p className="lp-pfoot" data-reveal>
        Text post <span className="mono">{CREDIT_PRICES.text_post} cr</span> · image <span className="mono">{CREDIT_PRICES.image_medium_1024} cr</span> ·
        720p reel <span className="mono">{CREDIT_PRICES.video_8s_720p_quality} cr</span>. Top up anytime at {topupLabel(currency)}.
        {currency === 'INR' ? ' Billed in ₹ with a GST invoice.' : ' Dollar figures are approximate; every plan is charged in ₹.'}
      </p>
    </>
  );
}

/** Seconds per example in public/hero/hero-reel.mp4, and where each step starts within one. */
const SCENE = 8;
const AT = { typed: 0.25, dev: 1.35, fan: 2.7, filed: 4.5, out: 7.55 };

/**
 * Which flags the hero showcase shows at time `t` of the reel: the example
 * (s), the brief typed, the reel developed, the platform versions fanned out,
 * and which example's post is filed in its week (the last one until this one files).
 */
export function showcaseState(t: number) {
  const s = Math.floor(t / SCENE) % 3;
  const lt = t - Math.floor(t / SCENE) * SCENE;
  const live = (from: number) => lt >= from && lt < AT.out;
  return { s, typed: live(AT.typed), dev: live(AT.dev), fan: live(AT.fan), filed: lt >= AT.filed ? s : (s + 2) % 3, p: lt / SCENE };
}

/**
 * Play/pause for the hero showcase, and its clock. The video's currentTime
 * drives data-* flags on the server-rendered figure; CSS does the motion.
 * Plays muted only while on screen and the tab is visible; never starts on
 * its own under reduced motion (the figure stays the finished frame).
 */
export function ShowcasePlayer() {
  const btn = useRef<HTMLButtonElement>(null);
  const want = useRef(false);
  const [on, setOn] = useState(true);
  const [reduce, setReduce] = useState(false);
  const sync = useRef<() => void>(() => {});
  const toggle = useRef<() => void>(() => {});
  useEffect(() => {
    const fig = btn.current?.closest<HTMLElement>('.sx');
    const v = fig?.querySelector('video');
    const reel = fig?.querySelector<HTMLElement>('.sx-reel');
    const prog = fig?.querySelector<HTMLElement>('.sx-prog');
    if (!fig || !v || !reel || !prog) return;
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReduce(rm);
    want.current = !rm;
    setOn(!rm);
    // The poster is a tiny placeholder (so it never outweighs the headline as
    // LCP). Reduced motion keeps the finished frame, so show the real one: the
    // first example, finished, at 7.5 s.
    let still = rm;
    const finished = () => { v.currentTime = 7.5; };
    if (rm) {
      v.preload = 'auto';
      v.addEventListener('loadedmetadata', finished, { once: true });
      v.load();
    }
    let seen = false;
    let raf = 0;
    let last = '';

    // The new post's thumbnail travels from the reel into its day.
    const fly = (s: number) => {
      const th = fig.querySelector<HTMLElement>(`.sx-week.s${s} .new .sx-th`);
      if (!th || rm) return;
      const a = th.getBoundingClientRect();
      const b = reel.getBoundingClientRect();
      th.animate(
        [
          { transform: `translate(${b.left + b.width / 2 - a.left - a.width / 2}px, ${b.top + b.height / 2 - a.top - a.height / 2}px) scale(${b.width / a.width})`, opacity: 0.4 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 800, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
    };
    const tick = () => {
      const st = showcaseState(v.currentTime);
      prog.style.transform = `scaleX(${st.p})`;
      const key = `${st.s}${+st.typed}${+st.dev}${+st.fan}${st.filed}`;
      if (key !== last) {
        const filedNow = last !== '' && fig.dataset.filed !== String(st.filed) && st.filed === st.s;
        last = key;
        fig.dataset.s = String(st.s);
        fig.dataset.filed = String(st.filed);
        fig.toggleAttribute('data-typed', st.typed);
        fig.toggleAttribute('data-dev', st.dev);
        fig.toggleAttribute('data-fan', st.fan);
        if (filedNow) fly(st.s);
      }
      if (!v.paused) raf = requestAnimationFrame(tick);
    };
    sync.current = () => {
      const go = want.current && seen && !document.hidden;
      if (go && v.paused) {
        v.muted = true;
        v.play().catch(() => { want.current = false; setOn(false); fig.toggleAttribute('data-paused', true); });
      } else if (!go && !v.paused) v.pause();
    };
    const onPlay = () => { fig.toggleAttribute('data-playing', true); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); };
    const onPause = () => { fig.toggleAttribute('data-playing', false); cancelAnimationFrame(raf); };
    const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; sync.current(); }, { threshold: 0.25 });
    const vis = () => sync.current();
    toggle.current = () => {
      want.current = !want.current;
      setOn(want.current);
      if (still) { still = false; v.currentTime = 0; } // first play starts at the brief
      fig.toggleAttribute('data-paused', !want.current);
      sync.current();
    };
    // The reel itself is a pointer shortcut for the same control.
    const click = () => toggle.current();
    reel.addEventListener('click', click);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    document.addEventListener('visibilitychange', vis);
    io.observe(fig);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      reel.removeEventListener('click', click);
      v.removeEventListener('loadedmetadata', finished);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  return (
    <button ref={btn} type="button" className="btn lp-pill lp-ghost sm sx-pp" onClick={() => toggle.current()} aria-label={on ? 'Pause the example' : 'Play the example'}>
      <Icon name={on ? 'pause' : 'play'} size={14} />
      {on ? 'Pause' : reduce ? 'Play example' : 'Play'}
    </button>
  );
}

/** The hub's kind filter. Every card stays in the HTML; this only sets data-filter on the grid. */
export function HubFilter({ counts }: { counts: Record<'all' | 'write' | 'image' | 'video', number> }) {
  const [f, setF] = useState<keyof typeof counts>('all');
  const ref = useRef<HTMLDivElement>(null);
  const pick = (v: keyof typeof counts) => {
    setF(v);
    ref.current?.parentElement?.querySelector('.hub-grid')?.setAttribute('data-filter', v);
  };
  const lbl = (t: string, n: number) => <>{t} <span className="seg-aside">{n}</span></>;
  return (
    <div ref={ref} className="hub-bar">
      <Seg
        label="Filter tools"
        value={f}
        onChange={pick}
        options={[
          { id: 'all', label: lbl('All', counts.all) },
          { id: 'write', label: lbl('Writing', counts.write) },
          { id: 'image', label: lbl('Images', counts.image) },
          { id: 'video', label: lbl('Video', counts.video) },
        ]}
      />
    </div>
  );
}
