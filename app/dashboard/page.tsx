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
  const { user } = useUser();
  const { mutate } = useSWRConfig();
  // `now` stays null through SSR + the first client render so meta.h1 is
  // hydration-stable. We then set it in useEffect, which upgrades the
  // greeting to the time-of-day variant on the next client render.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
  }, []);

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

  const displayName = user?.firstName || user?.fullName || user?.username || null;
  const meta = usePageMeta(page === 'onboarding' ? 'dashboard' : page, displayName, now);

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
