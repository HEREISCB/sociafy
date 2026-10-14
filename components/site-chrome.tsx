import Link from 'next/link';
import { RevealObserver } from './reveal-observer';

// Static site header/footer shared by every public page (landing, free tools,
// legal, 404). Server component on purpose: keeps these pages off the landing
// client chunk.

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

export const LPNav = () => (
  <header className="lp-nav-wrap">
    <div className="lp lp-nav">
      <Brand />
      <nav className="lp-nav-links" aria-label="Primary">
        <Link href="/#pricing">Pricing</Link>
        <Link href="/free-tools">Free tools</Link>
      </nav>
      <div className="lp-nav-actions">
        <Link className="btn ghost lp-nav-login" href="/sign-in">Log in</Link>
        <Link className="btn primary" href="/sign-up">Get started</Link>
        {/* Native disclosure: no JS, works on the server-rendered pages too. */}
        <details className="lp-menu">
          <summary aria-label="Menu">Menu</summary>
          <nav aria-label="Mobile">
            <Link href="/#pricing">Pricing</Link>
            <Link href="/free-tools">Free tools</Link>
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
        <a href="mailto:support@sociafy.app">Support</a>
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
export const SiteShell = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <>
    <a className="skip-link" href="#main">Skip to content</a>
    <LPNav />
    <main id="main" className={className}>{children}</main>
    <Footer />
    <RevealObserver />
  </>
);
