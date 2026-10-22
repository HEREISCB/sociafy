'use client';

/**
 * Bits shared by the /account pages: the route switcher and the formatters.
 * Buttons, Modal, toast and empty states come from components/ui.tsx.
 */

import { useLayoutEffect, useRef } from 'react';
import Link from 'next/link';

/** "14 Nov" — the one date format on these pages. */
export const shortDate = (d: string | Date) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
/** "14 Nov 2026" */
export const longDate = (d: string | Date) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
/** Paise → "₹2,998" or "₹457.32". */
export const inr = (minor: number) =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const num = (n: number) => n.toLocaleString('en-IN');
/** "+1,000" / "−315" with a real minus sign. */
export const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${num(Math.abs(n))}`;

/**
 * Route tabs dressed as the shared <Seg> (same .seg/.seg-ind classes, same
 * sliding ink indicator), but links with aria-current rather than radios:
 * each tab is a real URL. <Seg> itself is a radiogroup, so it can't be reused.
 */
export function AccountTabs({ tabs, active }: { tabs: readonly { href: string; label: string }[]; active: string }) {
  const root = useRef<HTMLElement | null>(null);
  const ind = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    const bar = ind.current;
    if (!el || !bar) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('[aria-current="page"]');
      if (!on || !el.clientWidth) return;
      const l = on.offsetLeft - 3;
      bar.style.clipPath = `inset(0 ${el.clientWidth - 6 - l - on.offsetWidth}px 0 ${l}px round 999px)`;
      requestAnimationFrame(() => el.setAttribute('data-ready', ''));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  return (
    <nav ref={root} className="mode-switch seg acct-tabs" aria-label="Account pages">
      <span ref={ind} className="seg-ind" aria-hidden="true" />
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === active ? 'page' : undefined}
          className={`opt${t.href === active ? ' active' : ''}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
