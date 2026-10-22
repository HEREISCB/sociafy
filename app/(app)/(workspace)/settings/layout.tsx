'use client';

import { useLayoutEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSettingsCounts } from '../../../../components/settings-overview';

// Routes stay put; only the labels changed (Connections → Accounts, Voice → Voice twins).
const NAV: { group: string; items: { href: string; label: string; key: string }[] }[] = [
  { group: '', items: [{ href: '/settings', label: 'Overview', key: '' }] },
  { group: 'Publishing', items: [{ href: '/settings/connections', label: 'Accounts', key: 'accounts' }] },
  { group: 'Your brand', items: [{ href: '/settings/brand', label: 'Brand kit', key: 'brand' }, { href: '/settings/voice', label: 'Voice twins', key: 'voice' }] },
  { group: 'Listening', items: [{ href: '/settings/mentions', label: 'Mentions', key: 'mentions' }] },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const counts = useSettingsCounts();
  const rail = useRef<HTMLElement | null>(null);
  const ind = useRef<HTMLSpanElement | null>(null);
  const isActive = (href: string) => (href === '/settings' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));

  // The ink indicator slides to the active link; the first placement doesn't animate.
  useLayoutEffect(() => {
    const on = rail.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const bar = ind.current;
    if (!bar) return;
    bar.style.opacity = on ? '1' : '0';
    if (on) bar.style.transform = `translateY(${on.offsetTop}px)`;
    requestAnimationFrame(() => rail.current?.setAttribute('data-ready', ''));
  }, [pathname]);

  const badge = (key: string, chip = false) => {
    if (key === 'accounts' && counts.broken) {
      return <span className="set-cnt"><span className="set-dot" aria-label={`${counts.broken} need reconnecting`} />{chip ? '' : ` ${counts.broken}`}</span>;
    }
    if (chip) return key === 'mentions' && counts.mentions ? <span className="set-cnt">{counts.mentions}</span> : null;
    if (key === 'brand' && counts.kit) return <span className="set-cnt">{counts.kit}</span>;
    if (key === 'voice' && counts.voices) return <span className="set-cnt">{counts.voices}</span>;
    if (key === 'mentions' && counts.mentions) return <span className="set-cnt" aria-label={`${counts.mentions} to review`}>{counts.mentions}</span>;
    return null;
  };

  return (
    <div className="set-layout">
      <aside className="set-rail">
        <nav ref={rail} className="set-rail-nav" aria-label="Settings">
          <span ref={ind} className="set-rail-ind" aria-hidden="true" />
          {NAV.map((g) => (
            <div key={g.group || 'top'} className="set-rail-group">
              {g.group && <div className="set-grp">{g.group}</div>}
              {g.items.map((s) => (
                <Link key={s.href} href={s.href} aria-current={isActive(s.href) ? 'page' : undefined}>
                  {s.label}
                  {badge(s.key)}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <nav className="set-chips" aria-label="Settings sections">
        {NAV.flatMap((g) => g.items).map((s) => (
          <Link key={s.href} href={s.href} aria-current={isActive(s.href) ? 'page' : undefined}>
            {s.label}
            {badge(s.key, true)}
          </Link>
        ))}
      </nav>
      <div key={pathname} className="set-body arrive">{children}</div>
    </div>
  );
}
