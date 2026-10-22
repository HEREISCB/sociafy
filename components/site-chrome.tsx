import Link from 'next/link';
import { RevealObserver } from './reveal-observer';
import { Icon } from './icons';

// Static site header/footer shared by every public page (landing, free tools,
// legal, developers, 404). Server component on purpose: keeps these pages off
// the landing client chunk.

export const COMPANY = 'GNIX SEMICONDUCTORS PRIVATE LIMITED';
export const COMPANY_ADDRESS = '2TF, Satyam Complex 2, Sector Alpha II, Greater Noida, Uttar Pradesh 201310, India';

export const PG = ({ k }: { k: string }) => (
  <span className={`pglyph ${k}`} aria-hidden="true">
    {({ ig: 'I', fb: 'f', x: 'X', li: 'in', tt: 'T', yt: 'Y', th: '@' } as Record<string, string>)[k]}
  </span>
);

const Brand = () => (
  <Link href="/" className="brand lp-brand" aria-label="Sociafy home">
    <span className="brand-mark" aria-hidden="true">S</span>
    <span className="brand-name">Sociafy<span className="dot">.</span></span>
  </Link>
);

type Section = 'tools' | 'developers';
const NAV: [string, string, Section?][] = [
  ['/#how', 'How it works'],
  ['/#pricing', 'Pricing'],
  ['/free-tools', 'Free tools', 'tools'],
  ['/developers/reference', 'Developers', 'developers'],
];

const NavLinks = ({ current }: { current?: Section }) =>
  NAV.map(([href, label, s]) => (
    <Link key={href} href={href} aria-current={s && s === current ? 'page' : undefined}>{label}</Link>
  ));

export const LPNav = ({ current }: { current?: Section }) => (
  <header className="lp-nav-wrap">
    <div className="lp lp-nav">
      <Brand />
      <nav className="lp-nav-links" aria-label="Primary"><NavLinks current={current} /></nav>
      <div className="lp-nav-actions">
        <Link className="btn ghost lp-nav-login" href="/sign-in">Log in</Link>
        <Link className="btn primary lp-pill" href="/sign-up">Get started</Link>
        {/* Native disclosure: no JS, works on the server-rendered pages too. */}
        <details className="lp-menu">
          <summary aria-label="Menu"><Icon name="list" /></summary>
          <nav aria-label="Mobile">
            <NavLinks current={current} />
            <Link href="/sign-in">Log in</Link>
          </nav>
        </details>
      </div>
    </div>
  </header>
);

export const Footer = () => (
  <footer className="lp-foot">
    <div className="lp lp-foot-grid">
      <div>
        <Brand />
        <p className="lp-foot-note">
          A product of {COMPANY}, {COMPANY_ADDRESS}.
        </p>
        <p className="lp-foot-note">© 2026 {COMPANY}</p>
      </div>
      <nav className="lp-foot-col" aria-label="Product">
        <h2>Product</h2>
        <Link href="/#pricing">Pricing</Link>
        <Link href="/free-tools">Free tools</Link>
        <Link href="/developers/reference">API reference</Link>
      </nav>
      <nav className="lp-foot-col" aria-label="Company">
        <h2>Company</h2>
        <a href="mailto:support@sociafy.app">Support</a>
        <Link href="/sign-in">Log in</Link>
      </nav>
      <nav className="lp-foot-col" aria-label="Legal">
        <h2>Legal</h2>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/terms">Terms</Link>
        <Link href="/legal/refund">Refund &amp; cancellation</Link>
      </nav>
    </div>
  </footer>
);

/** Header + main + footer, for every public page. */
export const SiteShell = ({ children, className, current }: { children: React.ReactNode; className?: string; current?: Section }) => (
  <>
    <a className="skip-link" href="#main">Skip to content</a>
    <LPNav current={current} />
    <main id="main" className={className}>{children}</main>
    <Footer />
    <RevealObserver />
  </>
);

export type TocItem = { id: string; label: string };

/**
 * A long document with a table of contents: sticky on the left on desktop, a
 * collapsible "On this page" on phones. The highlight follows the reading
 * position (scroll-spy in reveal-observer.tsx, keyed on [data-spy]).
 */
export const DocLayout = ({ toc, head, children }: { toc: TocItem[]; head: React.ReactNode; children: React.ReactNode }) => {
  const links = toc.map((t) => <a key={t.id} href={`#${t.id}`}>{t.label}</a>);
  return (
    <div className="lp doc">
      <nav className="doc-toc" aria-label="On this page" data-spy>
        <b>On this page</b>
        {links}
      </nav>
      <article className="doc-body">
        {head}
        <details className="card doc-mtoc">
          <summary>On this page <Icon name="chevron_down" /></summary>
          <nav aria-label="On this page, phone" data-spy>{links}</nav>
        </details>
        {children}
      </article>
    </div>
  );
};

/** '2026-05-23' → '23 May 2026'. */
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const POLICIES = [
  ['privacy', '/legal/privacy', 'Privacy'],
  ['terms', '/legal/terms', 'Terms'],
  ['refund', '/legal/refund', 'Refund & cancellation'],
] as const;

/** Privacy, terms and refund: a chip switcher, a plain-words summary, a TOC. */
export const LegalShell = ({ page, title, intro, updated, summary, toc, children }: {
  page: (typeof POLICIES)[number][0];
  title: string;
  intro: React.ReactNode;
  updated: string;
  /** Three plain bullets. Non-binding; the sections govern. */
  summary: React.ReactNode[];
  toc: TocItem[];
  children: React.ReactNode;
}) => (
  <SiteShell className="legal">
    <DocLayout
      toc={toc}
      head={
        <>
          <nav className="legal-nav" aria-label="Policies">
            {POLICIES.map(([k, href, label]) => (
              <Link key={k} className="lp-chip" href={href} aria-current={k === page ? 'page' : undefined}>{label}</Link>
            ))}
          </nav>
          <h1>{title}</h1>
          <p className="legal-meta">{intro} · Last updated <span className="mono">{longDate(updated)}</span></p>
          <section className="card legal-short" aria-labelledby="short-h">
            <h2 id="short-h">The short version</h2>
            <ul>{summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
            <p>Summary only, in plain words. The sections below are the policy and they govern.</p>
          </section>
        </>
      }
    >
      {children}
    </DocLayout>
  </SiteShell>
);
