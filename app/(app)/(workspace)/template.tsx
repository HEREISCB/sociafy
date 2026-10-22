'use client';

import { useLayoutEffect } from 'react';

/** The first page of a visit is already on screen when this hydrates; only navigations animate. */
let firstMount = true;

/**
 * Route transition: re-mounts on every top-level workspace navigation and
 * replays the .arrive fade (200ms, primitives.css) on the page's scroll
 * container. No wrapper element, so `.page:has(> .compose)`-style layout
 * rules keep matching; no exit animation, so navigation is never delayed.
 * Reduced motion turns it into a short fade (motion.css).
 */
export default function Template({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    if (firstMount) { firstMount = false; return; }
    const el = document.getElementById('main');
    if (!el) return;
    el.classList.remove('arrive');
    void el.offsetWidth; // restart the animation
    el.classList.add('arrive');
  }, []);
  return children;
}
