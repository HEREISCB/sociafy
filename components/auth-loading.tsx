'use client';

import { useEffect, useState } from 'react';

/**
 * Shown while Clerk's frontend bundle initializes on the auth pages. If it
 * takes too long it usually means the auth provider's script is being blocked
 * (privacy browsers / shields / ad-blockers) or the instance isn't reachable,
 * so we surface a self-help hint instead of an indefinitely blank screen.
 */
export function AuthLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        minHeight: 160,
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--ink-3)', fontFamily: 'var(--mono, monospace)' }}>
        Loading secure sign-in…
      </span>
      {slow && (
        <p style={{ maxWidth: 340, textAlign: 'center', fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.6 }}>
          This is taking longer than usual. If you use a privacy browser or
          ad/script blocker (e.g. Brave Shields), it may be blocking the sign-in
          provider — try pausing it for this site or open in another browser.
        </p>
      )}
    </div>
  );
}
