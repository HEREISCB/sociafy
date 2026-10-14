'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// `desc` is the one-line section header every settings page opens with.
const SECTIONS = [
  { href: '/settings/connections', label: 'Connections', desc: 'The accounts Sociafy posts to.' },
  { href: '/settings/brand', label: 'Brand kit', desc: 'Everything we use to make posts and videos look and sound like you. Every item is optional.' },
  { href: '/settings/plan', label: 'Billing & usage', desc: 'Your credits, subscription, credit activity and invoices.' },
  { href: '/settings/voice', label: 'Voice', desc: 'Clone your voice so avatar videos speak like you.' },
  { href: '/settings/api', label: 'API keys', desc: "Keys call the Sociafy API and spend this account's credits, up to a daily cap per key." },
  { href: '/settings/mentions', label: 'Mentions', desc: 'Watch the web for your brand and reply to coverage that needs it.' },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const current = SECTIONS.find((s) => isActive(s.href));
  return (
    <>
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings">
          {SECTIONS.map((s) => {
            const active = isActive(s.href);
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
        <div className="settings-body">
          {current && (
            <header className="settings-head">
              <h2>{current.label}</h2>
              <p>{current.desc}</p>
            </header>
          )}
          {children}
        </div>
      </div>
    </>
  );
}
