'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sidebar, Topbar } from '../../components/shell';
import { Icon } from '../../components/icons';
import { ApiKeys } from '../../components/api-keys';
import { DeveloperDocs } from '../../components/developers';

type Page = 'dashboard' | 'compose' | 'agent' | 'calendar' | 'connections' | 'onboarding';

export default function DevelopersPage() {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app">
      <Sidebar
        // Same as /usage and /billing: this is a route, not a dashboard tab, so
        // no Workspace item is highlighted.
        page={'onboarding' as Page}
        onNav={(p) => router.push(p === 'dashboard' ? '/dashboard' : `/dashboard?tab=${p}`)}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        <Topbar crumbs={['Sociafy', 'Account', 'API']} onMenuClick={() => setSidebarOpen(true)}>
          <Link href="/dashboard" className="btn ghost">
            <Icon name="home" size={13} /> <span className="hide-mobile">Dashboard</span>
          </Link>
        </Topbar>
        <div className="page">
          <div className="page-head">
            <div>
              <h1>Developers</h1>
              <div className="sub">
                Generate video and images from your own code with an API key, billed in credits from
                this account. Keys, quickstart, prices and limits all live here.
              </div>
            </div>
          </div>

          {/* Reuses the /usage column layout — same centred 900px measure. */}
          <div className="usage-page">
            <ApiKeys />
            <DeveloperDocs />
          </div>
        </div>
      </div>
    </div>
  );
}
