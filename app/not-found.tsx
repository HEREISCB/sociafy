import Link from 'next/link';
import { SiteShell } from '../components/site-chrome';
import { Icon } from '../components/icons';
import { BackButton } from '../components/ui';
import { NotFoundFrame } from '../components/not-found-frame';
import { ACCOUNT, NAV } from '../lib/ui/nav';

export const metadata = {
  title: 'Page not found',
};

/**
 * The one 404 for every unmatched URL. Signed in, it keeps the app's frame
 * (a server look-alike of the shell — the real one needs Clerk's client) so a
 * mistyped /settings/x doesn't throw you out to the marketing site. Signed out,
 * it keeps the public nav. Both frames are static: calling auth() here made
 * every public page render per request, so the browser picks (NotFoundFrame).
 */
export default function NotFound() {
  return <NotFoundFrame publicFrame={<NotFoundPage user={false} />} appFrame={<NotFoundPage user />} />;
}

function NotFoundPage({ user }: { user: boolean }) {
  const body = (
    <div className="nf">
      <div className="arrive">
        <div className="nf-paper" aria-hidden="true" />
        <div className="nf-code">404</div>
        <h1>This page isn’t here</h1>
        <p>
          The link is old or mistyped.
          {user ? ' Nothing you made is lost — your posts and drafts are where you left them.' : ''}
        </p>
        <div className="nf-row">
          {user ? (
            <>
              <Link className="btn primary" href="/dashboard">Back to This week</Link>
              <Link className="btn" href="/compose"><Icon name="plus" size={14} /> New post</Link>
              <BackButton fallback="/dashboard" />
            </>
          ) : (
            <>
              <Link className="btn primary" href="/">Go to sociafy.app</Link>
              <Link className="btn" href="/sign-in">Log in</Link>
              <BackButton fallback="/" />
            </>
          )}
        </div>
      </div>
    </div>
  );

  if (!user) return <SiteShell className="lp nf-public">{body}</SiteShell>;

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="app">
        <aside className="sidebar" aria-label="Main">
          <Link href="/dashboard" className="brand" aria-label="Sociafy, This week">
            <div className="brand-mark" aria-hidden="true">S</div>
            <span className="brand-name">sociafy<span className="dot">.</span></span>
          </Link>
          <nav className="nav-section" aria-label="Workspace">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="nav-item"><Icon name={n.icon} className="ic" />{n.label}</Link>
            ))}
          </nav>
          <div className="sidebar-foot">
            <nav className="nav-section" aria-label="Account">
              <div className="nav-label" aria-hidden="true">Account</div>
              {ACCOUNT.map((n) => (
                <Link key={n.href} href={n.href} className="nav-item"><Icon name={n.icon} className="ic" />{n.label}</Link>
              ))}
            </nav>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="topbar-spacer" />
            <Link href="/compose" className="btn primary shell-new" aria-label="New post">
              <Icon name="plus" size={14} /> <span className="lbl">New post</span>
            </Link>
          </header>
          <main id="main" className="page" tabIndex={-1}>{body}</main>
        </div>
      </div>
    </>
  );
}
