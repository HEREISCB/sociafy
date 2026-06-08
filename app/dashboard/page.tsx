'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { useSWRConfig } from 'swr';
import { Sidebar, Topbar } from '../../components/shell';
import Dashboard from '../../components/dashboard';
import Compose from '../../components/compose';
import AgentPage from '../../components/agent';
import CalendarPage from '../../components/calendar';
import ConnectionsPage from '../../components/connections';
import Onboarding from '../../components/onboarding';

type Page = 'dashboard' | 'compose' | 'agent' | 'calendar' | 'connections' | 'onboarding';

/**
 * Time-of-day greeting. `now` MUST be null on the SSR / first-client render so
 * the server and client produce identical HTML — the server's hour-of-day is
 * in its own timezone (usually UTC), the client's is in the user's local zone,
 * so reading `new Date()` during SSR is a guaranteed hydration mismatch.
 *
 * Pass `null` on first render → returns "Hello, $name".
 * Pass a Date after mount → returns "Good morning/afternoon/evening, $name".
 */
function greetingFor(name: string | null | undefined, now: Date | null): string {
  const first = (name || '').split(' ')[0] || 'there';
  if (!now) return `Hello, ${first}`;
  const hour = now.getHours();
  const slot = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return `Good ${slot}, ${first}`;
}

function usePageMeta(page: Exclude<Page, 'onboarding'>, displayName: string | null | undefined, now: Date | null) {
  return useMemo(() => {
    const base: Record<Exclude<Page, 'onboarding'>, { crumbs: string[]; h1: string; sub: string }> = {
      dashboard: {
        crumbs: ['Sociafy', 'Workspace', 'Dashboard'],
        h1: greetingFor(displayName, now),
        sub: "Here's what's queued for today and what your agent has been watching.",
      },
      compose: {
        crumbs: ['Sociafy', 'Workspace', 'Compose'],
        h1: 'Compose',
        sub: "Tell the agent what to write — it'll adapt for every platform.",
      },
      agent: {
        crumbs: ['Sociafy', 'Workspace', 'Auto-pilot'],
        h1: 'Auto-pilot',
        sub: "Your agent's activity, guardrails, and what it's watching.",
      },
      calendar: {
        crumbs: ['Sociafy', 'Workspace', 'Calendar'],
        h1: 'Calendar',
        sub: 'Drag, schedule, or let the agent fill the gaps.',
      },
      connections: {
        crumbs: ['Sociafy', 'Workspace', 'Connections'],
        h1: 'Connections',
        sub: 'Connect, reconnect, or disconnect every platform Sociafy posts to.',
      },
    };
    return base[page];
  }, [page, displayName, now]);
}

const RefreshIcon = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 8a5.5 5.5 0 019.5-3.5M13.5 8a5.5 5.5 0 01-9.5 3.5" /><path d="M11.5 1.5v3h-3M4.5 14.5v-3h3" />
  </svg>
);

const SparkleIcon = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.5 4.5l2 2M9.5 9.5l2 2M11.5 4.5l-2 2M6.5 9.5l-2 2" />
  </svg>
);

function initialPageFromUrl(): Page {
  if (typeof window === 'undefined') return 'dashboard';
  const tab = new URLSearchParams(window.location.search).get('tab');
  const valid: Page[] = ['dashboard', 'compose', 'agent', 'calendar', 'connections', 'onboarding'];
  return (valid as string[]).includes(tab ?? '') ? (tab as Page) : 'dashboard';
}

export default function Home() {
  const [page, setPage] = useState<Page>(initialPageFromUrl);
  const [refreshing, setRefreshing] = useState(false);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, isLoaded, isSignedIn } = useUser();
  const { mutate } = useSWRConfig();
  // `now` stays null through SSR + the first client render so meta.h1 is
  // hydration-stable. We then set it in useEffect, which upgrades the
  // greeting to the time-of-day variant on the next client render.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
  }, []);

  // When the page is restored from the browser's back/forward cache (bfcache) —
  // e.g. the user hit Back from an OAuth provider — the dashboard JS state is
  // restored AS IT WAS, including any stale SWR cache from before the round
  // trip. Force a full revalidation on pageshow so we always show fresh data
  // post-OAuth instead of a half-rendered "blank dashboard".
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        void mutate(() => true, undefined, { revalidate: true });
      }
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [mutate]);

  // Redirect to sign-in once Clerk confirms the user isn't authed. proxy.ts
  // already does server-side auth.protect() for /dashboard, but a client-side
  // fallback covers the bfcache case where Clerk's local session was invalidated
  // mid-OAuth and the user is now effectively signed-out on a cached page.
  useEffect(() => {
    if (isLoaded && !isSignedIn && typeof window !== 'undefined') {
      window.location.replace('/sign-in?next=/dashboard');
    }
  }, [isLoaded, isSignedIn]);

  const goCompose = (draftId?: string | null) => {
    setEditingDraftId(draftId ?? null);
    setPage('compose');
  };

  const goDashboard = () => {
    setEditingDraftId(null);
    setPage('dashboard');
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await mutate(() => true, undefined, { revalidate: true });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '1') { e.preventDefault(); setPage('dashboard'); }
        if (e.key === '2') { e.preventDefault(); setPage('compose'); }
        if (e.key === '3') { e.preventDefault(); setPage('agent'); }
        if (e.key === '4') { e.preventDefault(); setPage('calendar'); }
        if (e.key === '5') { e.preventDefault(); setPage('connections'); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Same fallback order as the UserCard sidebar so the greeting and the
  // avatar agree. Clerk users created via email-only or via an OAuth provider
  // that didn't share a name end up with firstName/fullName/username all null;
  // the email prefix is the next best thing.
  const displayName =
    user?.firstName ||
    user?.fullName ||
    user?.username ||
    user?.primaryEmailAddress?.emailAddress?.split('@')[0] ||
    null;
  const meta = usePageMeta(page === 'onboarding' ? 'dashboard' : page, displayName, now);

  // Hold the dashboard render until Clerk has resolved auth on the client.
  // Without this, the page briefly mounts with user=null, every component
  // renders its empty/unauth state, and the user sees a "blank dashboard"
  // for ~200-500ms — especially jarring when coming back from an OAuth
  // round-trip via bfcache. A lightweight skeleton avoids the flash.
  if (!isLoaded) {
    return (
      <div
        className="app"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
        }}
      >
        <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div
            aria-hidden
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: '2.5px solid var(--line, #e5e5e5)',
              borderTopColor: 'var(--accent, oklch(0.72 0.18 55))',
              animation: 'sociafy-spin 0.8s linear infinite',
            }}
          />
          <span
            style={{
              fontSize: 12.5,
              color: 'var(--ink-3, #888)',
              fontFamily: 'var(--mono, monospace)',
              letterSpacing: '0.08em',
            }}
          >
            Loading your workspace…
          </span>
          <style>{`@keyframes sociafy-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  // Once Clerk confirms unauth, the useEffect above redirects. Return null in
  // the meantime so we don't flash a half-rendered dashboard during the redirect.
  if (!isSignedIn) {
    return null;
  }

  if (page === 'onboarding') {
    return <Onboarding onDone={() => setPage('dashboard')} />;
  }

  return (
    <div className="app">
      <Sidebar
        page={page}
        onNav={setPage}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        <Topbar
          crumbs={meta.crumbs}
          onAutopilotClick={() => setPage('agent')}
          onMenuClick={() => setSidebarOpen(true)}
        >
          <button className="btn primary" onClick={() => setPage('compose')}>
            <SparkleIcon /> Compose
          </button>
        </Topbar>
        <div className="page">
          <div className="page-head">
            <div>
              <h1>{meta.h1}</h1>
              <div className="sub">{meta.sub}</div>
            </div>
            <div className="page-head-actions">
              {page === 'dashboard' && (
                <>
                  <button className="btn" onClick={refreshAll} disabled={refreshing}>
                    <RefreshIcon /> {refreshing ? 'Refreshing…' : 'Refresh briefing'}
                  </button>
                </>
              )}
            </div>
          </div>

          {page === 'dashboard' && <Dashboard onCompose={() => goCompose()} onEditDraft={(id) => goCompose(id)} />}
          {page === 'compose' && <Compose draftId={editingDraftId} onDone={goDashboard} />}
          {page === 'agent' && <AgentPage onEditDraft={(id) => goCompose(id)} />}
          {page === 'calendar' && <CalendarPage onCompose={() => goCompose()} />}
          {page === 'connections' && <ConnectionsPage />}
        </div>
      </div>
    </div>
  );
}
