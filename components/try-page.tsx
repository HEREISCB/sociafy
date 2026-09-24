import Link from 'next/link';
import { LPNav, Footer } from './site-chrome';
import { TryTool } from './try-tool';

type Props = {
  kind: 'image' | 'video';
  h1: React.ReactNode;
  lede: string;
  steps: [string, string][];
  faq: [string, string][];
};

const BENEFITS: [string, string][] = [
  ['Writes in your voice', 'Sociafy learns how you write from your own posts and website, so drafts sound like you, not like a bot.'],
  ['Autopilot that never runs dry', 'It watches trends in your niche and drafts fresh posts on a schedule you set.'],
  ['Images and videos built in', 'Every post can come with its own AI image or short video, made in the same place you write it.'],
  ['Every platform, one calendar', 'Plan and publish to X, LinkedIn, Instagram, Facebook, TikTok and YouTube from a single calendar.'],
  ['You stay in control', 'Approve every post yourself, or let Sociafy publish the strong ones at the best time to post.'],
  ['Predictable spend', 'Simple credits with a weekly cap you choose, so autopilot never spends more than you planned.'],
];

/** Why sign up — right under the result, where the visitor is deciding. */
function Benefits() {
  return (
    <div style={{ maxWidth: 960, margin: '40px auto 0', textAlign: 'left' }}>
      <h2 style={{ textAlign: 'center', fontSize: 26, letterSpacing: '-0.02em', margin: '0 0 6px' }}>
        More than a generator. <span className="accent">Your social media, on autopilot.</span>
      </h2>
      <p style={{ textAlign: 'center', color: 'var(--ink-3)', margin: '0 auto 22px', maxWidth: 600, fontSize: 15 }}>
        The free account that removes your watermark also gets you Sociafy, the AI agent that runs your socials while you build.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        {BENEFITS.map(([t, d]) => (
          <div key={t} className="card" style={{ padding: 18 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>{t}</h3>
            <p style={{ fontSize: 13.5, color: 'var(--ink-3)', margin: 0, lineHeight: 1.5 }}>{d}</p>
          </div>
        ))}
      </div>
      <div style={{ textAlign: 'center', marginTop: 20 }}>
        <Link className="btn btn-lg primary" href="/sign-up">Create your free account</Link>
      </div>
    </div>
  );
}

/** Server-rendered shell for /try-image and /try-video: everything but the tool itself is static HTML for crawlers. */
export function TryPage({ kind, h1, lede, steps, faq }: Props) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name: `Sociafy free AI ${kind} generator`,
        url: `https://sociafy.app/try-${kind}`,
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Any',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      },
    ],
  };
  const other = kind === 'image' ? 'video' : 'image';
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <LPNav />
      <main id="main">
        <section className="hero" style={{ textAlign: 'center' }}>
          <div className="lp">
            <span className="hero-eyebrow"><span className="pill">FREE</span> No sign-up to try</span>
            <h1 style={{ maxWidth: 820, margin: '16px auto' }}>{h1}</h1>
            <p className="hero-lede" style={{ maxWidth: 640, margin: '0 auto 28px' }}>{lede}</p>
            <TryTool kind={kind} />
            <Benefits />
          </div>
        </section>

        <section className="lp-section">
          <div className="lp">
            <div className="lp-section-head">
              <div>
                <div className="lp-section-eyebrow">How it works</div>
                <h2>Three steps, <em>under a minute</em>.</h2>
              </div>
            </div>
            <div className="faq">
              {steps.map(([t, d], i) => (
                <div className="faq-item" key={t}>
                  <div className="faq-num">/ 0{i + 1}</div>
                  <div className="faq-q">{t}</div>
                  <div className="faq-a">{d}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section" id="faq">
          <div className="lp">
            <div className="lp-section-head">
              <div>
                <div className="lp-section-eyebrow">FAQ</div>
                <h2>Questions <em>people ask</em>.</h2>
              </div>
              <p className="blurb">
                Need a {other} instead? Try the <Link href={`/try-${other}`} style={{ textDecoration: 'underline' }}>free AI {other} generator</Link>.
              </p>
            </div>
            <div className="faq">
              {faq.map(([q, a], i) => (
                <div className="faq-item" key={q}>
                  <div className="faq-num">/ 0{i + 1}</div>
                  <div className="faq-q">{q}</div>
                  <div className="faq-a">{a}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
