'use client';

import { useEffect, useState } from 'react';

/**
 * Shown while Clerk's frontend bundle initializes on the auth pages. If it
 * takes too long it usually means the auth provider's script is being blocked
 * (privacy browsers / shields / ad-blockers) or the instance isn't reachable,
 * so after 8s we swap to a self-help message instead of an endless spinner.
 */
export function AuthLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000);
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
        textAlign: 'center',
        fontSize: 'var(--fs-md, 14px)',
        lineHeight: 1.55,
        color: 'var(--text-2)',
      }}
    >
      {slow ? (
        <>
          <p style={{ margin: 0, maxWidth: 360 }}>
            This is taking longer than usual. A privacy browser or ad blocker can stop it from loading. Pause it for this
            site, or try another browser.
          </p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
          <p style={{ margin: 0, fontSize: 'var(--fs-sm, 13px)', color: 'var(--text-3)' }}>
            Still stuck? Email <a href="mailto:support@sociafy.app" style={{ textDecoration: 'underline' }}>support@sociafy.app</a>.
          </p>
        </>
      ) : (
        <span style={{ color: 'var(--text-3)' }}>Loading sign-in…</span>
      )}
    </div>
  );
}
