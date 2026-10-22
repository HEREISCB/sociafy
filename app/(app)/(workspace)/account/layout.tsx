'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '../../../../components/icons';
import type { CreditsPayload } from '../../../../components/credits';
import { useApi } from '../../../../lib/ui/fetcher';
import { AccountTabs, num } from '../../../../components/billing/account-ui';

const PAGES = [
  { href: '/account/billing', label: 'Billing', sub: 'Your plan, your credits and what things cost.' },
  { href: '/account/usage', label: 'Usage', sub: 'Where your credits went this cycle.' },
  { href: '/account/invoices', label: 'Invoices', sub: 'GST invoices for every payment, and who they’re made out to.' },
  { href: '/account/api', label: 'API keys', sub: 'Call Sociafy from your own code. Keys spend this account’s credits, up to a daily cap.' },
] as const;

/**
 * One sticky header for every account page: title, the balance, Top up, and
 * the switcher. Top up stays reachable without scrolling on all four; it is
 * the ink primary everywhere except API keys, where Create key is.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? '';
  const page = PAGES.find((p) => path.startsWith(p.href)) ?? PAGES[0];
  // Same SWR key as the topbar meter, so this is one request, not two.
  const { data } = useApi<CreditsPayload>('/api/credits', { refreshInterval: 30_000 });

  return (
    <div className="acct">
      <header className="acct-head">
        <div className="acct-head-top">
          <div className="acct-head-title">
            <h1>{page.label}</h1>
            <p className="acct-head-sub">{page.sub}</p>
          </div>
          <span className="acct-bal" title="Credits left">
            <Icon name="bolt" size={12} />
            <b className="mono">{data ? num(data.balance) : '—'}</b>
            <span className="mono">cr</span>
          </span>
          <Link
            href="/account/billing?topup=1"
            className={`btn ${page.href === '/account/api' ? '' : 'primary'} acct-topup`}
            scroll={false}
          >
            <Icon name="plus" size={14} /> Top up
          </Link>
        </div>
        <AccountTabs tabs={PAGES} active={page.href} />
      </header>
      <div key={page.href} className="acct-body">{children}</div>
    </div>
  );
}
