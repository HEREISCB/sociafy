import React from 'react';
import Link from 'next/link';
import type { Currency } from '../lib/billing/pricing';
import { CREDIT_PRICES } from '../lib/credits/pricing';
import type { Tier } from '../lib/db/schema';
import { FREE_TOOLS } from '../lib/free-tools';
import { TRY_PAGES, TRY_PER_DAY, TRY_WAIT } from '../lib/try-presets';
import { Icon } from './icons';
import { SiteShell, PG } from './site-chrome';
import { DevelopAgain, HeroPrice, Pricing } from './landing-islands';

// Server component: the page is static HTML plus three small islands
// (hero price, pricing, the tray's replay button).

/** Runs before the tray paints: a visitor who already watched it this session sees it finished. */
const DEVELOPED = `try{sessionStorage.getItem('sfy-developed')&&document.documentElement.setAttribute('data-developed','')}catch(e){}`;

const ink = { fontFamily: 'var(--sans)' };

/** An example post, drawn inline (no image request, fixed aspect ratio). */
const PostArt = () => (
  <svg viewBox="0 0 400 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="dt-g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#F6C89F" /><stop offset="1" stopColor="#E07B39" /></linearGradient>
      <linearGradient id="dt-g2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#1d1410" /><stop offset=".55" stopColor="#3a2a20" /><stop offset="1" stopColor="#140d0a" /></linearGradient>
    </defs>
    <rect width="400" height="320" fill="url(#dt-g1)" />
    <circle cx="310" cy="96" r="62" fill="#FBE3C6" opacity=".7" />
    <rect y="250" width="400" height="70" fill="#c9652a" opacity=".55" />
    <ellipse cx="200" cy="292" rx="86" ry="12" fill="#000" opacity=".22" />
    <path d="M138 110h124l-7 172a12 12 0 01-12 11h-86a12 12 0 01-12-11z" fill="url(#dt-g2)" />
    <rect x="134" y="100" width="132" height="16" rx="4" fill="#2b1f18" />
    <rect x="148" y="168" width="104" height="70" rx="4" fill="#FAFAF7" />
    <text x="200" y="198" textAnchor="middle" fontWeight="600" fontSize="13" fill="#0A0A0A" style={ink}>COLD BREW</text>
    <text x="200" y="218" textAnchor="middle" fontSize="7" fill="#6B6B66" style={{ fontFamily: 'var(--mono)' }}>WINTER BATCH · 500ML</text>
    <text x="26" y="52" fontWeight="600" fontSize="28" fill="#0A0A0A" style={ink}>20% off</text>
    <text x="26" y="74" fontSize="13" fill="#3a2a20" style={ink}>this week · Bengaluru</text>
  </svg>
);

const WEEK: [string, string][] = [
  ['Mon', '#0A66C2'],
  ['Tue', 'linear-gradient(135deg,#6b4a2f,#F6C89F)'],
  ['Wed', '#0A0A0A'],
  ['Thu', 'linear-gradient(135deg,#3a2a20,#E07B39)'],
  ['Fri', '#FF0000'],
];
// Each phase: when it becomes current (--a) and for how long (--b). Mirrors the keyframe delays in landing.css.
const PHASES: [string, number, number][] = [
  ['Caption, in your voice', 250, 650],
  ['Image develops', 900, 1000],
  ['Filed to Thursday', 1900, 1200],
];

/**
 * The signature: an example post develops from blank paper to a finished
 * print, then files itself into Thursday. Pure CSS keyframes on this HTML;
 * paused until it scrolls into view, finished at once under reduced motion.
 */
const DevelopTray = () => (
  <figure className="dt play" data-inview aria-label="Example: a post is drafted in your voice, its image develops, and it is scheduled for Thursday">
    <script dangerouslySetInnerHTML={{ __html: DEVELOPED }} />
    <div className="card dt-card">
      <div className="dt-head">
        <span className="dt-av" aria-hidden="true" />
        <div><b>Third Wave Brew Co.</b><span>Instagram · Thu 9:30 AM</span></div>
        <span className="dt-pill">
          <span className="badge">Draft</span>
          <span className="badge ok">Scheduled</span>
        </span>
      </div>
      <div className="dt-cap">
        <div className="dt-ghost" aria-hidden="true"><i /><i /><i /></div>
        <p className="dt-txt">Cold-brew season is back. Our winter batch steeps for 18 hours, smoother than ever. This week only: 20% off, Bengaluru delivery.</p>
      </div>
      <div className="dt-frame"><PostArt /></div>
    </div>
    <ol className="dt-phases" aria-hidden="true">
      {PHASES.map(([t, a, b]) => <li key={t} style={{ '--a': `${a}ms`, '--b': `${b}ms` } as React.CSSProperties}><i />{t}</li>)}
    </ol>
    <div className="dt-week" aria-hidden="true">
      {WEEK.map(([d, bg]) => (
        <div key={d} className={`dt-slot${d === 'Thu' ? ' thu' : ''}`}><span className="mono">{d.toUpperCase()}</span><span className="t" style={{ background: bg }} /></div>
      ))}
    </div>
    <div className="dt-bar">
      <span>This week: <span className="mono dt-n"><span>4</span><span>5</span></span><span className="mono"> of 5</span> scheduled</span>
      <DevelopAgain />
    </div>
  </figure>
);

const Hero = ({ currency }: { currency: Currency | null }) => (
  <section className="lp lp-hero">
    <div>
      <p className="lp-eyebrow"><span className="pip" />For founders who would rather be building</p>
      <h1>A month of posts, done in one sitting.</h1>
      <p className="hero-lede">
        Sociafy drafts the captions, images and videos for every platform in your voice. You review the plan,
        approve it, and it posts for you.
      </p>
      <div className="lp-cta">
        <Link className="btn primary btn-lg lp-pill" href="/sign-up">Get started</Link>
        <Link className="btn btn-lg lp-pill lp-ghost" href="#pricing">See pricing</Link>
      </div>
      <p className="lp-meta">From <HeroPrice initial={currency} />/mo · paid plans only · cancel anytime</p>
    </div>
    <DevelopTray />
  </section>
);

const PLATFORMS: [string, string][] = [['li', 'LinkedIn'], ['ig', 'Instagram'], ['fb', 'Facebook'], ['x', 'X'], ['tt', 'TikTok'], ['yt', 'YouTube']];
const Platforms = () => (
  <div className="lp"><p className="lp-plats"><span>Posts to</span>{PLATFORMS.map(([k, n]) => <span key={k}><PG k={k} />{n}</span>)}</p></div>
);

const Tick = () => <span className="lp-tick" aria-hidden="true"><Icon name="check" size={11} strokeWidth={2} /></span>;
// Which days of a 4-week month are filled, and which of those are videos (accent).
const FILLED = [1, 3, 4, 8, 10, 11, 15, 17, 18, 22, 24, 25];

const STEPS: { t: string; d: string; vis: React.ReactNode }[] = [
  { t: 'Connect', d: 'Link your accounts and your website. Sociafy learns your voice from what you already wrote.', vis: (
    <>
      <div className="lp-vrow"><PG k="li" />LinkedIn<span className="sp" /><Tick /></div>
      <div className="lp-vrow"><PG k="ig" />Instagram<span className="sp" /><Tick /></div>
      <div className="lp-vrow"><Icon name="globe" />thirdwavebrew.in<span className="sp" /><span className="lp-note">Voice learned</span></div>
    </>
  ) },
  { t: 'Review your plan', d: 'Read the drafts, change what you like, approve the rest. Every draft shows what it costs.', vis: (
    <>
      <div className="lp-vrow">Winter batch launch<span className="sp" /><span className="badge ok">Approved</span></div>
      <div className="lp-vrow">Why 18 hours of steeping<span className="sp" /><span className="badge ok">Approved</span></div>
      <div className="lp-vrow">Meet the roaster<span className="sp" /><span className="badge accent">Needs you</span></div>
    </>
  ) },
  { t: 'It posts', d: 'Approved posts go out on schedule, on every platform, while you get on with your work.', vis: (
    <div className="lp-month">
      {Array.from({ length: 28 }, (_, i) => <i key={i} className={FILLED.includes(i) ? (i % 7 === 4 ? 'p a' : 'p') : undefined} />)}
    </div>
  ) },
];

const HowItWorks = () => (
  <section className="lp lp-sec" id="how" aria-labelledby="how-h">
    <h2 id="how-h" data-reveal>Once a week or once a month. Then it is off your desk.</h2>
    <p className="lp-sub" data-reveal>You come in, read what was made, change what you like, approve the rest, and leave.</p>
    <ol className="lp-steps">
      {STEPS.map(({ t, d, vis }, i) => (
        <li key={t} className="card" data-reveal={i ? i + 1 : ''}>
          <span className="lp-n">0{i + 1}</span>
          <h3>{t}</h3>
          <p>{d}</p>
          <div className="lp-vis" aria-hidden="true">{vis}</div>
        </li>
      ))}
    </ol>
  </section>
);

const img = TRY_PAGES[0];
const TOOLS3: { href: string; name: string; job: string; out: string; go: string }[] = [
  { href: FREE_TOOLS.caption.slug, name: FREE_TOOLS.caption.title, job: FREE_TOOLS.caption.blurb, out: FREE_TOOLS.caption.sample, go: 'Write captions' },
  { href: FREE_TOOLS.hashtag.slug, name: FREE_TOOLS.hashtag.title, job: FREE_TOOLS.hashtag.blurb, out: FREE_TOOLS.hashtag.sample, go: 'Get hashtags' },
  { href: img.path, name: 'AI image generator', job: img.blurb, out: `${TRY_PER_DAY.image} free images a day · ${TRY_WAIT.image}`, go: 'Make an image' },
];

const FreeTools = () => (
  <section className="lp lp-sec" aria-labelledby="tools-h">
    <h2 id="tools-h" data-reveal>Or start with a free tool.</h2>
    <p className="lp-sub" data-reveal>One job each, no account. When you want it done every week, Sociafy does it in your voice.</p>
    <div className="lp-tools3">
      {TOOLS3.map((t, i) => (
        <Link key={t.href} href={t.href} className="card lp-tcard" data-reveal={i ? i + 1 : ''}>
          <b>{t.name}</b>
          <p>{t.job}</p>
          <span className="lp-out">{t.out}</span>
          <span className="lp-go">{t.go} <Icon name="arrow_right" /></span>
        </Link>
      ))}
    </div>
    <p className="lp-all"><Link href="/free-tools">All {6 + TRY_PAGES.length} free tools</Link></p>
  </section>
);

const FAQ = ({ credits }: { credits: Record<Tier, number> }) => {
  const c = (t: Tier) => credits[t].toLocaleString('en-US');
  const items: [string, React.ReactNode][] = [
    ['How do credits work?', `A text post costs ${CREDIT_PRICES.text_post} credit, an image ${CREDIT_PRICES.image_medium_1024} and a 720p reel ${CREDIT_PRICES.video_8s_720p_quality}. Plans include ${c('starter')}, ${c('pro')} or ${c('business')} credits a month. Every button that spends credits shows the cost first.`],
    ['Does it post without my approval?', 'On Starter, never: you schedule every post. Autopilot (Pro and Business) posts each draft at its planned time by default, and you can edit or skip any of them in This week before then. Switch it to Ask me first and nothing posts until you approve it.'],
    ['Which platforms are supported?', 'X, LinkedIn, Instagram, Facebook, TikTok and YouTube, on every plan. Each gets a post shaped for it, not a copy-paste.'],
    ['Can I cancel?', <>Anytime, from Plan settings. It takes effect at the end of your billing cycle. Plans are paid from day one. See the <Link href="/legal/refund">refund policy</Link>.</>],
  ];
  return (
    <section className="lp lp-sec" id="faq" aria-labelledby="faq-h">
      <h2 id="faq-h" data-reveal>Questions</h2>
      <dl className="faq">
        {items.map(([q, a]) => (
          <div className="faq-item" key={q} data-reveal>
            <dt>{q}</dt>
            <dd>{a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

export default function LandingPage({ initialCurrency, credits }: { initialCurrency: Currency | null; credits: Record<Tier, number> }) {
  return (
    <SiteShell>
      <Hero currency={initialCurrency} />
      <Platforms />
      <HowItWorks />
      <FreeTools />
      <section className="lp lp-sec" id="pricing" aria-labelledby="pricing-h">
        <Pricing initial={initialCurrency} credits={credits} />
      </section>
      <FAQ credits={credits} />
      <section className="lp lp-sec lp-closer" aria-labelledby="closer-h">
        <h2 id="closer-h" data-reveal>Clear the month off your desk.</h2>
        <p data-reveal>One sitting to plan it. Sociafy posts it.</p>
        <Link className="btn primary btn-lg lp-pill" href="/sign-up">Get started</Link>
      </section>
    </SiteShell>
  );
}
