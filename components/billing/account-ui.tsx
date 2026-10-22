'use client';

/**
 * Small building blocks shared by the /account pages: the tab switcher with a
 * sliding ink indicator, a confirm sheet, a bottom toast, and the formatters.
 * Patterns copied from compose (Seg, compose-toast) with acct- class names.
 * ponytail: to replace with components/ui.tsx once that lands.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** Route tabs with one ink indicator that slides (clip-path, no reflow). */
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
      // First placement lands without sliding in from the edge.
      requestAnimationFrame(() => el.setAttribute('data-ready', ''));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  return (
    <nav ref={root} className="acct-tabs" aria-label="Account pages">
      <span ref={ind} className="acct-tabs-ind" aria-hidden="true" />
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} aria-current={t.href === active ? 'page' : undefined} className={t.href === active ? 'on' : ''}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Centred dialog on desktop, bottom sheet on phones. Escape and the scrim close
 * it unless `busy`; focus lands on the first enabled button and returns to
 * whatever opened it.
 */
export function Sheet({ open, onClose, title, busy, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  useEffect(() => { busyRef.current = busy; closeRef.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('.btn:not(:disabled)')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busyRef.current) closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      back?.focus?.({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="acct-scrim" onClick={() => { if (!busy) onClose(); }}>
      <div ref={box} className="acct-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Bottom toast that lives near the thumb, not at the top of a scrolled page. */
export function useToast(): [React.ReactNode, (msg: string) => void] {
  const [toast, setToast] = useState<{ id: number; msg: string } | null>(null);
  const show = useCallback((msg: string) => setToast({ id: Date.now(), msg }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);
  const node = (
    <div className="acct-toast-wrap" aria-live="polite">
      {toast && <div key={toast.id} className="acct-toast" role="status">{toast.msg}</div>}
    </div>
  );
  return [node, show];
}
