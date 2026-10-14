'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SECTIONS = [
  { href: '/settings/connections', label: 'Connections' },
  { href: '/settings/plan', label: 'Plan & usage' },
  { href: '/settings/voice', label: 'Voice' },
  { href: '/settings/brand', label: 'Brand' },
  { href: '/settings/api', label: 'API' },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      <div className="page-head">
        <div><h1>Settings</h1></div>
      </div>
      <nav className="media-tabs" aria-label="Settings" style={{ marginBottom: 20 }}>
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className={`opt ${pathname === s.href ? 'active' : ''}`}
            aria-current={pathname === s.href ? 'page' : undefined}
            style={{ textDecoration: 'none' }}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
