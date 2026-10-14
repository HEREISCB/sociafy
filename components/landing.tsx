'use client';

import React from 'react';
import Link from 'next/link';
import { tierPriceView, topupLabel, type Currency } from '../lib/billing/pricing';
import { CREDIT_PRICES } from '../lib/credits/pricing';
import type { Tier } from '../lib/db/schema';
import { SiteShell, PG } from './site-chrome';

type Credits = Record<Tier, number>;

const PLAN = [
  { day: 'Mon', k: 'li', kind: 'Post', text: 'What we learned shipping our first paid feature' },
  { day: 'Tue', k: 'ig', kind: 'Image', text: 'Behind the scenes: the new studio, before and after' },
  { day: 'Wed', k: 'x', kind: 'Post', text: 'Three things I stopped doing this quarter' },
  { day: 'Thu', k: 'tt', kind: 'Video', text: 'Ten seconds on how an order gets packed' },
  { day: 'Fri', k: 'yt', kind: 'Video', text: 'Weekly recap, with sound' },
];

const Hero = ({ currency }: { currency: Currency }) => (
  <section className="lp hero">
    <div>
      <h1>A month of posts, done in one sitting.</h1>
      <p className="hero-lede">
        Sociafy drafts the captions, images and videos for every platform in your voice; you
        review the plan, approve it, and it posts for you.
      </p>
      <Link className="btn primary btn-lg" href="/sign-up">Get started</Link>
      <p className="hero-meta">
        From {tierPriceView(currency, 'starter').display} /mo · cancel anytime · no free trial
      </p>
    </div>
    <figure className="card week-plan" aria-label="Example weekly plan">
      <figcaption className="card-head">
        <h3>This week&apos;s plan</h3>
        <span className="meta">{PLAN.length} posts</span>
      </figcaption>
      <ul>
        {PLAN.map((p) => (
          <li key={p.day}>
            <span className="week-day">{p.day}</span>
            <PG k={p.k} />
            <span className="week-text">{p.text}</span>
            <span className="badge">{p.kind}</span>
          </li>
        ))}
      </ul>
    </figure>
  </section>
);

const STEPS: [string, string][] = [
  ['Connect', 'Link your accounts and your website. Sociafy learns your voice from what you already wrote.'],
  ['Review your plan', 'Once a week or once a month, read the drafts, change what you like, approve the rest.'],
  ['It posts', 'Approved posts go out on schedule, on every platform, while you get on with your work.'],
];

const HowItWorks = () => (
  <section className="lp lp-section" aria-labelledby="how">
    <h2 id="how">How it works</h2>
    <ol className="steps">
      {STEPS.map(([t, d], i) => (
        <li key={t}>
          <span className="step-num">{i + 1}</span>
          <h3>{t}</h3>
          <p>{d}</p>
        </li>
      ))}
    </ol>
  </section>
);

/** Guess the visitor's currency from their timezone (no network). India →
 *  INR, everyone else → USD. A manual toggle lets them override. */
const detectCurrency = (): Currency => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'INR';
  } catch { /* SSR / unsupported */ }
  return 'USD';
};

const startCheckoutFromLanding = async (tier: Tier, setBusy: (t: Tier | null) => void) => {
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
      window.location.href = `/sign-up?next=${encodeURIComponent(`/settings/plan?tier=${tier}`)}`;
      return;
    }
    const data = await r.json().catch(() => ({} as { url?: string }));
    // No checkout URL means billing isn't configured; the plan page explains.
    window.location.href = data?.url ?? '/settings/plan';
  } finally {
    setBusy(null);
  }
};

const TIERS: { tier: Tier; name: string; bullets: string[] }[] = [
  { tier: 'starter', name: 'Starter', bullets: ['All 6 platforms', 'Text, image & 720p video', 'You schedule every post'] },
  { tier: 'pro', name: 'Pro', bullets: ['Everything in Starter', 'Autopilot plans your posts', 'Web research on captions', 'Priority email support'] },
  { tier: 'business', name: 'Business', bullets: ['Everything in Pro', 'Autopilot with images and video', '1080p hero clips', 'Onboarding call'] },
];

const Pricing = ({ currency, setCurrency, credits }: { currency: Currency; setCurrency: (c: Currency) => void; credits: Credits }) => {
  const [busy, setBusy] = React.useState<Tier | null>(null);
  return (
    <section className="lp lp-section" id="pricing" aria-labelledby="pricing-h">
      <div className="section-head">
        <h2 id="pricing-h">Pricing</h2>
        <div className="mode-switch" role="group" aria-label="Currency">
          {(['INR', 'USD'] as Currency[]).map((c) => (
            <button key={c} type="button" className={`opt${currency === c ? ' active' : ''}`} aria-pressed={currency === c} onClick={() => setCurrency(c)}>
              {c === 'INR' ? '₹ India' : '$ Global'}
            </button>
          ))}
        </div>
      </div>
      <div className="pricing">
        {TIERS.map(({ tier, name, bullets }) => {
          const v = tierPriceView(currency, tier);
          const n = credits[tier];
          return (
            <div className={`price-card${tier === 'pro' ? ' featured' : ''}`} key={tier}>
              <div className="price-name">
                {name}
                {tier === 'pro' && <span className="badge badge--accent">Most picked</span>}
              </div>
              <div className="price-amt">{v.display}<small> /mo</small></div>
              {v.approximate && <div className="price-note">Billed as {v.charge} /mo</div>}
              <ul className="price-list">
                <li>
                  {n.toLocaleString('en-US')} credits /mo · ~{Math.floor(n / CREDIT_PRICES.video_8s_720p_quality)} reels
                  or {Math.floor(n / CREDIT_PRICES.image_medium_1024).toLocaleString('en-US')} images
                </li>
                {bullets.map((b) => <li key={b}>{b}</li>)}
              </ul>
              <button
                type="button"
                className={`btn btn-lg${tier === 'pro' ? ' primary' : ''}`}
                onClick={() => startCheckoutFromLanding(tier, setBusy)}
                disabled={busy !== null}
              >
                {busy === tier ? 'Redirecting…' : `Choose ${name}`}
              </button>
            </div>
          );
        })}
      </div>
      <p className="pricing-foot">
        Text post {CREDIT_PRICES.text_post} credit · image {CREDIT_PRICES.image_medium_1024} · 720p reel {CREDIT_PRICES.video_8s_720p_quality}.
        Top up anytime at {topupLabel(currency)}.
        {currency === 'INR' ? ' Billed in ₹ with a GST invoice.' : ' Dollar figures are approximate; every plan is charged in ₹.'}
      </p>
    </section>
  );
};

const FAQ = ({ currency, credits }: { currency: Currency; credits: Credits }) => {
  const c = (t: Tier) => credits[t].toLocaleString('en-US');
  const items: [string, React.ReactNode][] = [
    ['How do credits work?', `A text post costs ${CREDIT_PRICES.text_post} credit, an image ${CREDIT_PRICES.image_medium_1024} and a 720p reel ${CREDIT_PRICES.video_8s_720p_quality}. Plans include ${c('starter')}, ${c('pro')} or ${c('business')} credits a month. Top up anytime at ${topupLabel(currency)}.`],
    ['Does it post without my approval?', 'No, unless you allow it. Autopilot (Pro and Business) is off by default, and you choose what it may publish on its own.'],
    ['Which platforms are supported?', 'X, LinkedIn, Instagram, Facebook, TikTok and YouTube, on every plan. Each gets a post shaped for it, not a copy-paste.'],
    ['Is there a free trial? Can I cancel?', <>No free trial. Cancel anytime from Plan settings; it takes effect at the end of your billing cycle. See the <Link href="/legal/refund">refund policy</Link>.</>],
  ];
  return (
    <section className="lp lp-section" id="faq" aria-labelledby="faq-h">
      <h2 id="faq-h">Questions</h2>
      <dl className="faq">
        {items.map(([q, a]) => (
          <div className="faq-item" key={q}>
            <dt>{q}</dt>
            <dd>{a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

/**
 * `initialCurrency` comes from the visitor's geo header, resolved on the server
 * in app/page.tsx, so prices are right in the initial HTML. Null means the
 * header was absent (local dev, or a host that doesn't geolocate): only then do
 * we guess from timezone. `credits` is TIER_CREDITS, passed from the server so
 * the db schema module stays out of this client chunk.
 */
export default function LandingPage({ initialCurrency, credits }: { initialCurrency: Currency | null; credits: Credits }) {
  const [currency, setCurrency] = React.useState<Currency>(initialCurrency ?? 'USD');
  React.useEffect(() => {
    if (!initialCurrency) setCurrency(detectCurrency());
  }, [initialCurrency]);
  return (
    <SiteShell>
      <Hero currency={currency} />
      <HowItWorks />
      <Pricing currency={currency} setCurrency={setCurrency} credits={credits} />
      <FAQ currency={currency} credits={credits} />
    </SiteShell>
  );
}
