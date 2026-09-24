import Link from 'next/link';

// Static site header/footer shared by the landing and /try-* pages. Server
// component on purpose: keeps these pages off the landing client chunk.

const ArrowIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const PG = ({ k }: { k: string }) => (
  <span className={`pglyph ${k}`} aria-hidden="true">
    {({ ig: 'I', fb: 'f', x: 'X', li: 'in', tt: 'T', yt: 'Y', th: '@' } as Record<string, string>)[k]}
  </span>
);

export const LPNav = () => (
  <header className="lp-nav-wrap">
    <div className="lp lp-nav">
      <Link href="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }} aria-label="Sociafy home">
        <div className="brand-mark" aria-hidden="true">S</div>
        <div className="brand-name">Sociafy<span className="dot">.</span></div>
      </Link>
      <nav className="lp-nav-links" aria-label="Primary">
        <Link href="/#agent">Agent</Link>
        <Link href="/#workflow">Workflow</Link>
        <Link href="/#voice">Voice</Link>
        <Link href="/#pricing">Pricing</Link>
        <Link href="/try-image">Free image</Link>
        <Link href="/try-video">Free video</Link>
      </nav>
      <div className="lp-nav-spacer" />
      <div className="lp-nav-actions">
        <span className="lp-nav-status"><span className="dot" /> Built for founders who&apos;d rather be building</span>
        <Link className="btn" href="/sign-in">Log in</Link>
        <Link className="btn primary" href="/sign-up">
          Start now <ArrowIcon />
        </Link>
      </div>
    </div>
  </header>
);

export const Footer = () => (
  <footer className="lp-foot">
    <div className="lp">
      <div className="lp-foot-grid">
        <div className="lp-foot-brand">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">S</div>
            <div className="brand-name">Sociafy<span className="dot">.</span></div>
          </div>
          <p>The AI social agent for founders who&apos;d rather be building.</p>
          <div className="lp-foot-socials" style={{ marginTop: 16 }}>
            <PG k="x" /><PG k="li" /><PG k="ig" /><PG k="yt" />
          </div>
        </div>
        <div className="lp-foot-col">
          <h6>Product</h6>
          <ul>
            <li><Link href="/#agent">Agent</Link></li>
            <li><Link href="/#workflow">Workflow</Link></li>
            <li><Link href="/#voice">Voice training</Link></li>
            <li><Link href="/#pricing">Pricing</Link></li>
          </ul>
        </div>
        <div className="lp-foot-col">
          <h6>Free tools</h6>
          <ul>
            <li><Link href="/try-image">Free AI image generator</Link></li>
            <li><Link href="/try-video">Free AI video generator</Link></li>
          </ul>
        </div>
        <div className="lp-foot-col">
          <h6>Company</h6>
          <ul>
            <li><a href="mailto:hello@sociafy.app">Contact</a></li>
            <li><a href="mailto:careers@sociafy.app">Careers</a></li>
          </ul>
        </div>
        <div className="lp-foot-col">
          <h6>Resources</h6>
          <ul>
            <li><a href="mailto:support@sociafy.app">Support</a></li>
            <li><Link href="/#voice">Voice guide</Link></li>
            <li><Link href="/#pricing">Pricing</Link></li>
          </ul>
        </div>
        <div className="lp-foot-col">
          <h6>Legal</h6>
          <ul>
            <li><a href="/legal/privacy">Privacy</a></li>
            <li><a href="/legal/terms">Terms</a></li>
            <li><a href="/legal/refund">Refund &amp; Cancellation</a></li>
          </ul>
        </div>
      </div>
      <div className="lp-foot-bottom" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
        <span>Sociafy is a product of <strong>GNIX SEMICONDUCTORS PRIVATE LIMITED</strong>.</span>
        <span>2TF, Satyam Complex 2, Sector Alpha II, Greater Noida, Uttar Pradesh 201310, India</span>
        <span>© 2026 GNIX SEMICONDUCTORS PRIVATE LIMITED · Made for founders.</span>
      </div>
    </div>
  </footer>
);
