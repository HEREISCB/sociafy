'use client';

// The few interactive bits of the public pages. Everything around them is
// server-rendered HTML; these hydrate on their own.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tierPriceView, topupLabel, type Currency } from '../lib/billing/pricing';
import { CREDIT_PRICES } from '../lib/credits/pricing';
import type { Tier } from '../lib/db/schema';

/**
 * Segmented control with one sliding ink indicator (clip-path, no reflow).
 * Copied from compose's Seg with lp- class names; to replace with ui.tsx.
 */
export function LpSeg<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: readonly { id: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const ind = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    const bar = ind.current;
    if (!el || !bar) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!on || !el.clientWidth) return;
      const l = on.offsetLeft - 3;
      bar.style.clipPath = `inset(0 ${el.clientWidth - 6 - l - on.offsetWidth}px 0 ${l}px round 999px)`;
      // First placement lands without sliding in from the edge.
      requestAnimationFrame(() => el.setAttribute('data-ready', ''));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return (
    <div ref={root} className="lp-seg" role="radiogroup" aria-label={label}>
      <span ref={ind} className="lp-seg-ind" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

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
        <LpSeg
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
                {tier === 'pro' && <span className="badge badge--accent">Most picked</span>}
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

/**
 * Replay for the hero tray. The tray itself is CSS keyframes on server HTML;
 * this only restarts them. Disabled while the print is still developing.
 * Marks the session so a reload shows the finished tray (plays once per visit).
 */
export function DevelopAgain() {
  const btn = useRef<HTMLButtonElement>(null);
  const [running, setRunning] = useState(true);
  useEffect(() => {
    const tray = btn.current?.closest<HTMLElement>('.dt');
    if (!tray) return;
    const still = document.documentElement.hasAttribute('data-developed') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) setRunning(false);
    const done = (e: AnimationEvent) => {
      if (e.animationName !== 'dt-file') return;
      setRunning(false);
      try { sessionStorage.setItem('sfy-developed', '1'); } catch { /* private mode */ }
    };
    tray.addEventListener('animationend', done);
    return () => tray.removeEventListener('animationend', done);
  }, []);
  const replay = () => {
    const tray = btn.current?.closest<HTMLElement>('.dt');
    if (!tray) return;
    setRunning(true);
    document.documentElement.removeAttribute('data-developed');
    tray.classList.remove('play');
    void tray.offsetWidth; // restart the keyframes
    tray.classList.add('play');
  };
  return (
    <button ref={btn} type="button" className="btn lp-pill lp-ghost sm" disabled={running} onClick={replay}>
      Develop again
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
  const lbl = (t: string, n: number) => <>{t} <span className="lp-count">{n}</span></>;
  return (
    <div ref={ref} className="hub-bar">
      <LpSeg
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
