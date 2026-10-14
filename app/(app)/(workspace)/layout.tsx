'use client';

import { useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { Sidebar, Topbar } from '../../../components/shell';

// The signed-in app shell: sidebar + topbar mounted once for every workspace
// and settings route. Sign-in, sign-up and onboarding sit outside this group.
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { mutate } = useSWRConfig();

  // When a page is restored from the back/forward cache (bfcache) — e.g. the
  // user hit Back from an OAuth provider — JS state comes back AS IT WAS,
  // including a stale SWR cache from before the round trip. Revalidate
  // everything on pageshow so it never shows half-stale data post-OAuth.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void mutate(() => true, undefined, { revalidate: true });
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [mutate]);

  return (
    <div className="app">
      <Sidebar mobileOpen={sidebarOpen} onMobileClose={() => setSidebarOpen(false)} />
      <div className="main">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />
        <div className="page">{children}</div>
      </div>
    </div>
  );
}
