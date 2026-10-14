import Link from 'next/link';
import { TRY_PAGES } from '../lib/try-presets';
import type { Metadata } from 'next';
import { SiteShell } from './site-chrome';
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

/** Links to every other free tool; shared by tool pages and the hub. `exclude` is a path. */
export function ToolLinks({ exclude }: { exclude?: string }) {
  const links = [
    ...FREE_TOOL_IDS.map((id) => ({ href: FREE_TOOLS[id].slug, title: FREE_TOOLS[id].title })),
    ...TRY_PAGES.map((t) => ({ href: t.path, title: t.title.replace(/^Free /, '') })),
  ].filter((l) => l.href !== exclude);
  return (
    <ul className="tool-links">
      {links.map((l) => (
        <li key={l.href}><Link href={l.href}>{l.title}</Link></li>
      ))}
    </ul>
  );
}

/** JSON-LD for a free tool page: the app itself plus its FAQ. */
export function toolJsonLd(name: string, path: string, category: string, faq: [string, string][]) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name,
        url: `https://sociafy.app${path}`,
        applicationCategory: category,
        operatingSystem: 'Any',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      },
    ],
  };
}

type ShellProps = {
  path: string;
  jsonLd: object;
  h1: React.ReactNode;
  lede: string;
  /** The interactive tool (client component). */
  children: React.ReactNode;
  steps: [string, string][];
  faq: [string, string][];
};

/** Server-rendered shell for every free tool page: all copy is static HTML for crawlers. */
export function ToolPageShell({ path, jsonLd, h1, lede, children, steps, faq }: ShellProps) {
  return (
    <SiteShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <section className="lp tool-hero">
        <p className="tool-eyebrow">Free · no sign-up needed</p>
        <h1>{h1}</h1>
        <p className="hero-lede">{lede}</p>
        {children}
      </section>

      <section className="lp lp-section" aria-labelledby="how">
        <h2 id="how" data-reveal>How it works</h2>
        <ol className="steps">
          {steps.map(([t, d], i) => (
            <li key={t} data-reveal={i ? i + 1 : ''}>
              <span className="step-num">{i + 1}</span>
              <h3>{t}</h3>
              <p>{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp lp-section" id="faq" aria-labelledby="faq-h">
        <h2 id="faq-h" data-reveal>Questions</h2>
        <dl className="faq">
          {faq.map(([q, a]) => (
            <div className="faq-item" key={q} data-reveal>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="lp lp-section" aria-labelledby="more">
        <div className="section-head" data-reveal>
          <h2 id="more">More free tools</h2>
          <Link href="/free-tools">See all</Link>
        </div>
        <ToolLinks exclude={path} />
      </section>
    </SiteShell>
  );
}

export function TextToolPage({ tool, h1, lede, label, cta, examples, steps, faq }: Props) {
  const { slug, title } = FREE_TOOLS[tool];
  return (
    <ToolPageShell
      path={slug}
      jsonLd={toolJsonLd(`Sociafy free ${title.toLowerCase()}`, slug, 'BusinessApplication', faq)}
      h1={h1}
      lede={lede}
      steps={steps}
      faq={faq}
    >
      <TextTool tool={tool} label={label} cta={cta} examples={examples} />
    </ToolPageShell>
  );
}
