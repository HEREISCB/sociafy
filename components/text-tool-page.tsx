import Link from 'next/link';
import { TRY_PAGES } from '../lib/try-presets';
import type { Metadata } from 'next';
import { LPNav, Footer } from './site-chrome';
import { TextTool } from './text-tool';
import { FREE_TOOLS, FREE_TOOL_IDS, type FreeToolId } from '../lib/free-tools';

type Props = {
  tool: FreeToolId;
  h1: React.ReactNode;
  lede: string;
  /** Label above the textarea. */
  label: string;
  /** Generate button text. */
  cta: string;
  examples: string[];
  steps: [string, string][];
  faq: [string, string][];
};

export function toolMetadata(slug: string, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: slug },
    openGraph: { title, description, url: slug },
    twitter: { title, description },
  };
}

const BENEFITS: [string, string][] = [
  ['Writes in your voice', 'Sociafy learns how you write from your own posts and website, so drafts sound like you, not like a bot.'],
  ['Autopilot that never runs dry', 'It watches trends in your niche and drafts fresh posts on a schedule you set.'],
  ['Images and videos built in', 'Every post can come with its own AI image or short video, made in the same place you write it.'],
  ['Every platform, one calendar', 'Plan and publish to X, LinkedIn, Instagram, Facebook, TikTok and YouTube from a single calendar.'],
];

export function Benefits() {
  return (
    <div style={{ maxWidth: 960, margin: '40px auto 0', textAlign: 'left' }}>
      <h2 style={{ textAlign: 'center', fontSize: 26, letterSpacing: '-0.02em', margin: '0 0 6px' }}>
        More than a generator. <span className="accent">Your social media, on autopilot.</span>
      </h2>
      <p style={{ textAlign: 'center', color: 'var(--ink-3)', margin: '0 auto 22px', maxWidth: 600, fontSize: 15 }}>
        These tools are free forever. A free Sociafy account goes further: an AI agent that writes, designs and posts for you.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
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

/** Links to every other free tool; shared by tool pages and the hub. */
export function ToolLinks({ exclude }: { exclude?: FreeToolId }) {
  const links = [
    ...FREE_TOOL_IDS.filter((id) => id !== exclude).map((id) => ({ href: FREE_TOOLS[id].slug, title: `Free ${FREE_TOOLS[id].title}` })),
    ...TRY_PAGES.map((t) => ({ href: t.path, title: `Free ${t.title.replace(/^Free /, '')}` })),
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="card" style={{ padding: 18, fontWeight: 550, fontSize: 15 }}>
          {l.title} →
        </Link>
      ))}
    </div>
  );
}

/** Server-rendered shell for the /free-* text tools: all copy is static HTML for crawlers. */
export function TextToolPage({ tool, h1, lede, label, cta, examples, steps, faq }: Props) {
  const { slug, title } = FREE_TOOLS[tool];
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name: `Sociafy free ${title.toLowerCase()}`,
        url: `https://sociafy.app${slug}`,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Any',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      },
    ],
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <LPNav />
      <main id="main">
        <section className="hero" style={{ textAlign: 'center' }}>
          <div className="lp">
            <span className="hero-eyebrow"><span className="pill">FREE</span> No sign-up needed</span>
            <h1 style={{ maxWidth: 820, margin: '16px auto' }}>{h1}</h1>
            <p className="hero-lede" style={{ maxWidth: 640, margin: '0 auto 28px' }}>{lede}</p>
            <TextTool tool={tool} label={label} cta={cta} examples={examples} />
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

        <section className="lp-section">
          <div className="lp">
            <div className="lp-section-head">
              <div>
                <div className="lp-section-eyebrow">More free tools</div>
                <h2>Everything for your next post, <em>free</em>.</h2>
              </div>
              <p className="blurb"><Link href="/free-tools" style={{ textDecoration: 'underline' }}>See all free tools</Link></p>
            </div>
            <ToolLinks exclude={tool} />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
