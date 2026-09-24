import Link from 'next/link';
import { LPNav, Footer } from './landing';
import { TryTool } from './try-tool';

type Props = {
  kind: 'image' | 'video';
  h1: React.ReactNode;
  lede: string;
  steps: [string, string][];
  faq: [string, string][];
};

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
