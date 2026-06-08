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

function ClerkLoadingScreen() {
  // Surface diagnostic help after 4s — if Clerk hasn't loaded by then the
  // user almost certainly has a CNAME/proxy/blocker problem and a blank
  // spinner with no explanation is the worst possible UX.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 4_000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      className="app"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 24,
      }}
    >
      <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, maxWidth: 420, textAlign: 'center' }}>
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
        {slow && (
          <p style={{ fontSize: 12.5, color: 'var(--ink-3, #888)', lineHeight: 1.6, marginTop: 4 }}>
            Taking longer than usual. The auth provider might be blocked —
            check that browser extensions (privacy shields, ad-blockers) aren&apos;t
            blocking <code>clerk.sociafy.app</code>, or try refreshing the page.
          </p>
        )}
        <style>{`@keyframes sociafy-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

// Auto-recovery for the OAuth-back state. When the user hits Back from a
// platform's OAuth page, the browser's bfcache restores the dashboard but
// Clerk's client is often stuck in a paused/half-initialized state — the
// user sees "Loading your workspace…" forever. Empirically, a manual page
// refresh always fixes this (it re-initializes Clerk fresh). So if Clerk
// hasn't loaded after this many ms, we trigger that refresh automatically.
const CLERK_AUTOREFRESH_MS = 2_500;

// Hard ceiling for the loading spinner if the auto-refresh has already been
// attempted (and didn't help). After this we render the dashboard anyway
// and let the diagnostic copy in ClerkLoadingScreen guide the user.
const CLERK_LOAD_TIMEOUT_MS = 8_000;

// sessionStorage key tracking the last auto-refresh attempt so we never get
// into a reload loop when Clerk is genuinely broken. Cleared once Clerk
// loads successfully, so each fresh session gets one recovery attempt.
const CLERK_RELOAD_KEY = 'sociafy:clerk-reload';
const CLERK_RELOAD_DEDUP_MS = 60_000;

export default function Home() {
  const [page, setPage] = useState<Page>(initialPageFromUrl);
  const [refreshing, setRefreshing] = useState(false);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, isLoaded, isSignedIn } = useUser();
  const { mutate } = useSWRConfig();
  // Belt-and-suspenders timeout so we never leave the user stranded on the
  // spinner. After CLERK_LOAD_TIMEOUT_MS we proceed to render whatever we have.
  const [clerkTimedOut, setClerkTimedOut] = useState(false);
  useEffect(() => {
    if (isLoaded) return;
    const t = setTimeout(() => setClerkTimedOut(true), CLERK_LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [isLoaded]);

  // Auto-refresh-once when Clerk gets stuck. This is the OAuth-back recovery:
  // a full page reload re-initializes Clerk's client and always unsticks the
  // dashboard. sessionStorage dedup prevents an infinite reload loop if Clerk
  // is genuinely broken — after one attempt within CLERK_RELOAD_DEDUP_MS we
  // stop trying and fall through to the spinner timeout + diagnostic copy.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isLoaded) {
      // Clerk loaded — clear the dedup flag so future sessions can retry.
      try { sessionStorage.removeItem(CLERK_RELOAD_KEY); } catch {}
      return;
    }
    let lastAttempt = 0;
    try {
      lastAttempt = Number(sessionStorage.getItem(CLERK_RELOAD_KEY) || 0);
    } catch {}
    if (Date.now() - lastAttempt < CLERK_RELOAD_DEDUP_MS) return; // already tried
    const t = setTimeout(() => {
      try { sessionStorage.setItem(CLERK_RELOAD_KEY, String(Date.now())); } catch {}
      window.location.reload();
    }, CLERK_AUTOREFRESH_MS);
    return () => clearTimeout(t);
  }, [isLoaded]);
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

  // Once Clerk confirms unauth, the redirect effect above runs. Return null in
  // the meantime so we don't flash a half-rendered dashboard during the redirect.
  if (isLoaded && !isSignedIn) {
    return null;
  }

  // Loading state — shown while Clerk hydrates. Bounded by clerkTimedOut so
  // a stuck Clerk client (proxied CNAME, ad-blocker, etc.) never leaves the
  // user stranded; after the timeout we let the dashboard render anyway with
  // whatever state we have, plus a banner inside the dashboard explains it.
  if (!isLoaded && !clerkTimedOut) {
    return <ClerkLoadingScreen />;
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
