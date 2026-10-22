import Link from 'next/link';
import { TRY_PAGES } from '../lib/try-presets';
import type { Metadata } from 'next';
import { SiteShell } from './site-chrome';
import { TextTool } from './text-tool';
import { Icon } from './icons';
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

const SITE = 'https://sociafy.app';

export function toolMetadata(slug: string, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: slug },
    openGraph: { title, description, url: slug },
    twitter: { title, description },
  };
}

/** Links to every other free tool, for the foot of each tool page. `exclude` is a path. */
export function ToolLinks({ exclude }: { exclude?: string }) {
  const links = [
    ...FREE_TOOL_IDS.map((id) => ({ href: FREE_TOOLS[id].slug, title: FREE_TOOLS[id].title })),
    ...TRY_PAGES.map((t) => ({ href: t.path, title: t.title.replace(/^Free /, '') })),
  ].filter((l) => l.href !== exclude);
  return (
    <ul className="tool-links">
      {links.map((l) => (
        <li key={l.href}><Link href={l.href}>{l.title}<Icon name="arrow_right" /></Link></li>
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
        url: `${SITE}${path}`,
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
  /** Short tool name for the breadcrumb. */
  name: string;
  jsonLd: { '@graph': object[] };
  h1: React.ReactNode;
  lede: string;
  /** The interactive tool (client component). */
  children: React.ReactNode;
  steps: [string, string][];
  faq: [string, string][];
};

/**
 * Server-rendered shell for every free tool page: all copy is static HTML for
 * crawlers. The tool sits in the first screen; how-it-works, FAQ and the other
 * tools follow.
 */
export function ToolPageShell({ path, name, jsonLd, h1, lede, children, steps, faq }: ShellProps) {
  const ld = {
    ...jsonLd,
    '@graph': [
      ...jsonLd['@graph'],
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Free tools', item: `${SITE}/free-tools` },
          { '@type': 'ListItem', position: 2, name, item: `${SITE}${path}` },
        ],
      },
    ],
  };
  return (
    <SiteShell current="tools">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      <section className="lp tp">
        <nav className="tp-crumb" aria-label="Breadcrumb">
          <Link href="/free-tools">Free tools</Link>
          <Icon name="chevron_right" size={12} />
          <span aria-current="page">{name}</span>
        </nav>
        <div className="tp-head">
          <h1>{h1}</h1>
          <p>{lede}</p>
        </div>
        {children}
      </section>

      <section className="lp tp-steps" aria-labelledby="how">
        <h2 id="how" className="sr-only">How it works</h2>
        {steps.map(([t, d], i) => (
          <div key={t} data-reveal={i ? i + 1 : ''}>
            <span className="lp-n">0{i + 1}</span>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <section className="lp lp-sec" id="faq" aria-labelledby="faq-h">
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

      <section className="lp lp-sec" aria-labelledby="more">
        <div className="lp-phead" data-reveal>
          <h2 id="more">More free tools</h2>
          <Link className="lp-link" href="/free-tools">See all</Link>
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
      name={title}
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
