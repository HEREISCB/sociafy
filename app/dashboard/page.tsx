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
type Mode = 'manual' | 'auto';

function greetingFor(name: string | null | undefined): string {
  const hour = new Date().getHours();
  const slot = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const first = (name || '').split(' ')[0] || 'there';
  return `Good ${slot}, ${first}`;
}

function usePageMeta(page: Exclude<Page, 'onboarding'>, displayName: string | null | undefined) {
  return useMemo(() => {
    const base: Record<Exclude<Page, 'onboarding'>, { crumbs: string[]; h1: string; sub: string }> = {
      dashboard: {
        crumbs: ['Sociafy', 'Workspace', 'Dashboard'],
        h1: greetingFor(displayName),
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
  }, [page, displayName]);
}

const RefreshIcon = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 8a5.5 5.5 0 019.5-3.5M13.5 8a5.5 5.5 0 01-9.5 3.5" /><path d="M11.5 1.5v3h-3M4.5 14.5v-3h3" />
  </svg>
);

const UploadIcon = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 11V2M4.5 5.5L8 2l3.5 3.5M3 13.5h10" />
  </svg>
);

const SparkleIcon = () => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.5 4.5l2 2M9.5 9.5l2 2M11.5 4.5l-2 2M6.5 9.5l-2 2" />
  </svg>
);

export default function Home() {
  const [page, setPage] = useState<Page>('dashboard');
  const [mode, setMode] = useState<Mode>('manual');
  const [refreshing, setRefreshing] = useState(false);
  const { user } = useUser();
  const { mutate } = useSWRConfig();

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
  const meta = usePageMeta(page === 'onboarding' ? 'dashboard' : page, displayName);

  if (page === 'onboarding') {
    return <Onboarding onDone={() => setPage('dashboard')} />;
  }

  return (
    <div className="app">
      <Sidebar page={page} onNav={setPage} mode={mode} onMode={setMode} />
      <div className="main">
        <Topbar crumbs={meta.crumbs} mode={mode} onMode={setMode}>
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
                  <button className="btn"><UploadIcon /> Export</button>
                </>
              )}
            </div>
          </div>

          {page === 'dashboard' && <Dashboard mode={mode} onCompose={() => setPage('compose')} />}
          {page === 'compose' && <Compose />}
          {page === 'agent' && <AgentPage />}
          {page === 'calendar' && <CalendarPage />}
          {page === 'connections' && <ConnectionsPage />}
        </div>
      </div>
    </div>
  );
}
