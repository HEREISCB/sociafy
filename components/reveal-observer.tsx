'use client';

import { useEffect } from 'react';

/**
 * The public site's one client effect, mounted by SiteShell:
 * - Scroll reveal: anything marked `data-reveal` (or `data-inview`, which is
 *   observed but not hidden) gets `data-shown` once it enters the viewport.
 *   The hidden state is pure CSS under `html.reveal-ready` (set by the inline
 *   script in app/layout.tsx), so this only ever *shows* things. Watches for
 *   late-mounted content too.
 * - Scroll-spy for a `nav[data-spy]` table of contents: the link for the
 *   section being read gets aria-current.
 * - Copy buttons on code blocks (`[data-copy-code]`, rendered on the server).
 */
const SEL = '[data-reveal]:not([data-shown]), [data-inview]:not([data-shown])';

export function RevealObserver() {
  useEffect(() => {
    (window as unknown as { __revealBooted?: boolean }).__revealBooted = true;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.setAttribute('data-shown', '');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    );
    const watch = (root: ParentNode) => root.querySelectorAll(SEL).forEach((n) => io.observe(n));
    watch(document);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          if (n.matches(SEL)) io.observe(n);
          watch(n);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // Scroll-spy: the section being read is the last heading above the top
    // quarter (the first one before any has passed). The observer only says
    // "something crossed"; positions decide, so a jump back to the top resets it.
    const links = [...document.querySelectorAll<HTMLAnchorElement>('nav[data-spy] a[href^="#"]')];
    const heads = [...new Set(links.map((a) => a.hash))]
      .map((h) => document.getElementById(decodeURIComponent(h.slice(1))))
      .filter((t): t is HTMLElement => !!t);
    const spy = new IntersectionObserver(
      () => {
        let cur = heads[0];
        for (const h of heads) if (h.getBoundingClientRect().top <= innerHeight / 4) cur = h;
        for (const a of links) a.toggleAttribute('aria-current', a.hash === `#${cur.id}`);
      },
      { rootMargin: '0px 0px -75% 0px' },
    );
    heads.forEach((t) => spy.observe(t));

    const onClick = (e: MouseEvent) => {
      const b = (e.target as Element).closest?.('[data-copy-code]');
      const pre = b?.parentElement?.querySelector('pre');
      if (!b || !pre) return;
      void navigator.clipboard?.writeText(pre.textContent ?? '').catch(() => {});
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    };
    document.addEventListener('click', onClick);
    return () => { io.disconnect(); mo.disconnect(); spy.disconnect(); document.removeEventListener('click', onClick); };
  }, []);
  return null;
}
