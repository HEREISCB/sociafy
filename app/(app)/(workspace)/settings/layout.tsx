'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SECTIONS = [
  { href: '/settings/connections', label: 'Connections' },
  { href: '/settings/brand', label: 'Brand kit' },
  { href: '/settings/plan', label: 'Plan & usage' },
  { href: '/settings/voice', label: 'Voice' },
  { href: '/settings/api', label: 'API keys' },
  { href: '/settings/mentions', label: 'Mentions' },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const navRef = useRef<HTMLElement>(null);
  // On mobile the tabs scroll sideways; keep the current one in view.
  useEffect(() => {
    navRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);
  return (
    <>
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <div className="settings-layout">
        <nav ref={navRef} className="settings-nav" aria-label="Settings">
          {SECTIONS.map((s) => {
            const active = pathname === s.href || pathname.startsWith(`${s.href}/`);
            return (
              <Link
                key={s.href}
                href={s.href}
                className={active ? 'active' : undefined}
                aria-current={active ? 'page' : undefined}
              >
                {s.label}
              </Link>
            );
          })}
        </nav>
        <div className="settings-body">{children}</div>
      </div>
    </>
  );
}
