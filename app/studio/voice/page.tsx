'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sidebar, Topbar } from '../../../components/shell';
import { Icon } from '../../../components/icons';
import { VoicesManager } from '../../../components/voice-studio';

type Page = 'dashboard' | 'compose' | 'agent' | 'calendar' | 'connections' | 'onboarding';

export default function VoiceStudioPage() {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app">
      <Sidebar
        page={'onboarding' as Page}
        onNav={(p) => router.push(p === 'dashboard' ? '/dashboard' : `/dashboard?tab=${p}`)}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        <Topbar
          crumbs={['Sociafy', 'Studio', 'Voice']}
          onMenuClick={() => setSidebarOpen(true)}
        >
          <Link href="/dashboard" className="btn ghost">
            <Icon name="home" size={13} /> <span className="hide-mobile">Dashboard</span>
          </Link>
        </Topbar>
        <div className="page">
          <div className="page-head">
            <div>
              <h1>Voice Twin</h1>
              <div className="sub">
                Clone your voice once — then any post you write becomes a clip in your voice.
                Upload 20–60 seconds of clean audio to create a Twin.
              </div>
            </div>
          </div>
          <VoicesManager />
        </div>
      </div>
    </div>
  );
}
