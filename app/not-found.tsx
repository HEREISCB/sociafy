import Link from 'next/link';
import { SiteShell } from '../components/site-chrome';

export const metadata = {
  title: 'Not found · Sociafy',
};

export default function NotFound() {
  return (
    <SiteShell className="lp not-found">
      <p className="tool-eyebrow">404</p>
      <h1>Page not found</h1>
      <p className="hero-lede">The link is broken or the page has moved.</p>
      <Link className="btn primary btn-lg" href="/">Go home</Link>
    </SiteShell>
  );
}
