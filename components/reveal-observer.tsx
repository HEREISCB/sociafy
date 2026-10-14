'use client';

import { useEffect } from 'react';

/**
 * Scroll reveal for anything marked `data-reveal` on the public site: marks it
 * `data-shown` once it enters the viewport (once). The hidden state is pure CSS
 * under `html.reveal-ready` (set by the inline script in app/layout.tsx), so
 * this only ever *shows* things. Watches for late-mounted content too.
 */
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
    const watch = (root: ParentNode) => root.querySelectorAll('[data-reveal]:not([data-shown])').forEach((n) => io.observe(n));
    watch(document);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          if (n.matches('[data-reveal]:not([data-shown])')) io.observe(n);
          watch(n);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); };
  }, []);
  return null;
}
