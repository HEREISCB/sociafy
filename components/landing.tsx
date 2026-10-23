import React from 'react';
import Link from 'next/link';
import type { Currency } from '../lib/billing/pricing';
import { CREDIT_PRICES } from '../lib/credits/pricing';
import type { Tier } from '../lib/db/schema';
import { FREE_TOOLS } from '../lib/free-tools';
import { TRY_PAGES, TRY_PER_DAY, TRY_WAIT } from '../lib/try-presets';
import { Icon } from './icons';
import { SiteShell, PG } from './site-chrome';
import { HeroPrice, Pricing, ShowcasePlayer } from './landing-islands';

// Server component: the page is static HTML plus small islands (hero price,
// pricing, the showcase's play/pause).

type Scene = {
  brand: string;
  brief: string;
  when: string;
  ig: string;
  more: [string, string, string][];
  /** Mon..Sun: '' empty, else `<thumb>:<platform>`; thumb is new | a | b | txt. */
  week: string[];
};

/**
 * Three example briefs, in the order of public/hero/hero-reel.mp4: 8 s of
 * reel each (rendered with HyperFrames; source in scripts/hero-reel/).
 */
const SCENES: Scene[] = [
  {
    brand: 'Third Wave Brew Co.',
    brief: 'Winter batch promo, 20% off this week',
    when: 'Thu 9:30',
    ig: 'Cold-brew season is back. Our winter batch steeps for 18 hours, smoother than ever. 20% off this week, Bengaluru delivery.',
    more: [
      ['li', 'LinkedIn', '18 hours of steeping, one winter batch. What we learned taking cold brew from one café counter to 40 offices.'],
      ['x', 'X', 'Winter batch is live. 20% off until Sunday, Bengaluru only.'],
    ],
    week: ['a:ig', 'txt:li', '', 'new:ig', 'txt:x', 'b:fb', ''],
  },
  {
    brand: 'Ledgerly',
    brief: 'Announce recurring invoices',
    when: 'Tue 10:00',
    ig: 'Stop sending the same invoice every month. Turn on Repeat monthly once and Ledgerly sends it on the 1st, every month.',
    more: [
      ['li', 'LinkedIn', 'Freelancers told us the worst part of invoicing is sending the same one twice. So we built Repeat monthly.'],
      ['yt', 'YouTube Short', 'Recurring invoices, set up in 20 seconds.'],
    ],
    week: ['txt:li', 'new:ig', '', 'a:yt', 'txt:x', '', 'b:ig'],
  },
  {
    brand: 'Neel',
    brief: 'Indigo shirt drop, ₹1,499',
    when: 'Sat 7:00',
    ig: 'The indigo drop is here. Hand block-printed in Jaipur, cut for Bengaluru heat. ₹1,499 while the first run lasts.',
    more: [
      ['tt', 'TikTok', 'POV: your shirt was printed by hand. The indigo drop, ₹1,499.'],
      ['fb', 'Facebook', 'Three colours, one print block, 200 shirts. The indigo drop opens Saturday at 7.'],
    ],
    week: ['a:ig', '', 'txt:fb', 'b:ig', '', 'new:ig', 'txt:x'],
  },
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const filled = (s: Scene) => s.week.filter((d) => d && !d.startsWith('new')).length;

/**
 * The signature: a one-line brief becomes a captioned reel, the post is
 * re-cut for other platforms, and it files itself into the week. Three
 * examples on a 24 s loop. The video is the clock: ShowcasePlayer reads its
 * currentTime and sets the data-* flags here; CSS does every transition. The
 * server HTML is the finished first example (what reduced motion and no-JS see).
 */
const Showcase = () => (
  <figure
    className="sx" data-s="0" data-typed="" data-dev="" data-fan="" data-filed="0"
    aria-label="Example: from a one-line brief, Sociafy writes the caption, makes a short video, adapts the post for other platforms and schedules it into the week. Shown for a café, a software founder and a clothing brand."
  >
    <div className="sx-brief" aria-hidden="true">
      <span className="sx-k">Brief</span>
      <span className="sx-stack">{SCENES.map((s, i) => <span key={i} className={`sx-b s${i}`}>{s.brief}</span>)}</span>
    </div>
    <div className="sx-stage">
      <div className="sx-reel">
        <video className="sx-vid" poster="/hero/hero-reel-poster.webp" preload="none" muted playsInline loop disablePictureInPicture aria-hidden="true" tabIndex={-1}>
          <source src="/hero/hero-reel.webm" type="video/webm" />
          <source src="/hero/hero-reel.mp4" type="video/mp4" />
        </video>
        <span className="sx-chip" aria-hidden="true"><PG k="ig" />Reel</span>
        <span className="sx-big" aria-hidden="true"><Icon name="play" size={18} /></span>
        <i className="sx-prog" aria-hidden="true" />
      </div>
      <div className="sx-outs" aria-hidden="true">
        {SCENES.map((s, i) => (
          <div key={i} className={`sx-set s${i}`}>
            {[['ig', 'Instagram', s.ig] as [string, string, string], ...s.more].map(([k, n, t]) => (
              <div key={k} className={`sx-c ${k}`}>
                <div className="sx-ch"><PG k={k} /><span>{n}</span><span className="mono">{s.when}</span></div>
                <p>{t}</p>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
    <div className="sx-wk" aria-hidden="true">
      {SCENES.map((s, i) => (
        <div key={i} className={`sx-week s${i}`}>
          <div className="sx-wh">
            <span>This week · {s.brand}</span>
            <span className="sx-n"><span className="mono">{filled(s)}</span><span className="mono">{filled(s) + 1}</span><span> of 7 days</span></span>
          </div>
          <ol>
            {DAYS.map((d, j) => {
              const [kind, pk] = s.week[j].split(':');
              return (
                <li key={d} className={kind === 'new' ? 'new' : undefined}>
                  <span className="mono">{d}</span>
                  {kind
                    ? <span className={`sx-th ${kind}`} style={{ '--i': i } as React.CSSProperties}>{kind === 'txt' && <><b /><b /><b /></>}<PG k={pk} /><Tick /></span>
                    : <span className="sx-th" />}
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
    <div className="sx-bar">
      <span>One brief in. Caption, reel and platform versions out.</span>
      <ShowcasePlayer />
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
    <Showcase />
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
