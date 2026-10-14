'use client';

import { usePathname } from 'next/navigation';

// Account-level pages reached from the sidebar user menu. No sub-nav: each is
// a destination on its own, unlike the workspace Settings sections.
const PAGES: Record<string, { title: string; desc: string }> = {
  '/account/billing': { title: 'Billing & usage', desc: 'Your credits, subscription, credit activity and invoices.' },
  '/account/api': { title: 'API keys', desc: "Keys call the Sociafy API and spend this account's credits, up to a daily cap per key." },
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const page = PAGES[usePathname() ?? ''];
  return (
    <div className="settings-body">
      <header className="page-header">
        <div>
          <h1>{page?.title ?? 'Account'}</h1>
          {page && <p className="page-header__sub">{page.desc}</p>}
        </div>
      </header>
      {children}
    </div>
  );
}
