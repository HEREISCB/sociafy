'use client';

import React, { useEffect, useRef, useState, Fragment } from 'react';
import Link from 'next/link';
import { UserButton, useUser } from '@clerk/nextjs';
import { Icon } from './icons';

type Page = 'dashboard' | 'compose' | 'agent' | 'calendar' | 'connections' | 'onboarding';
type Mode = 'manual' | 'auto';

interface ModeSwitchProps {
  value: Mode;
  onChange: (v: Mode) => void;
}

export const ModeSwitch: React.FC<ModeSwitchProps> = ({ value, onChange }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 3, width: 0 });

  useEffect(() => {
    const opts = ref.current?.querySelectorAll<HTMLElement>('.opt') || [];
    const idx = value === 'manual' ? 0 : 1;
    const el = opts[idx];
    if (el) setPos({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value]);

  return (
    <div className="mode-switch" ref={ref}>
      <div className="pill" style={{ left: pos.left, width: pos.width }} />
      <span className={`opt ${value === 'manual' ? 'active' : ''}`} onClick={() => onChange('manual')}>
        <Icon name="edit" size={12} /> Co-pilot
      </span>
      <span className={`opt ${value === 'auto' ? 'active' : ''}`} onClick={() => onChange('auto')}>
        <Icon name="bolt" size={12} /> Agent
      </span>
    </div>
  );
};

interface SidebarProps {
  page: Page;
  onNav: (p: Page) => void;
  mode: Mode;
  onMode: (m: Mode) => void;
  showTTS?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ page, onNav, showTTS = true }) => {
  const items = [
    { id: 'dashboard' as Page, label: 'Dashboard', icon: 'home' as const, kbd: '1' },
    { id: 'compose' as Page, label: 'Compose', icon: 'sparkle' as const, kbd: '2', badge: 'AI', accent: true },
    { id: 'agent' as Page, label: 'Auto-pilot', icon: 'bolt' as const, kbd: '3' },
    { id: 'calendar' as Page, label: 'Calendar', icon: 'calendar' as const, kbd: '4' },
    { id: 'connections' as Page, label: 'Connections', icon: 'globe' as const, kbd: '5' },
  ];

  return (
    <aside className="sidebar">
      <Link href="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="brand-mark">S</div>
        <span className="brand-name">sociafy<span className="dot">.</span></span>
      </Link>

      <div className="nav-section">
        <div className="nav-label">Workspace</div>
        {items.map((it) => (
          <div
            key={it.id}
            className={`nav-item ${page === it.id ? 'active' : ''}`}
            onClick={() => onNav(it.id)}
          >
            <Icon name={it.icon} className="ic" />
            {it.label}
            {it.badge && (
              <span className={`badge ${it.accent ? 'accent' : ''}`}>{it.badge}</span>
            )}
            {!it.badge && <span className="kbd">⌘{it.kbd}</span>}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        {showTTS && (
          <div className="tts-card">
            <span className="pill">Soon</span>
            <h4>Voice posts</h4>
            <p>Turn any draft into a podcast clip with our TTS engine.</p>
            <div className="wave">
              {[6, 10, 4, 12, 8, 14, 7, 11, 5, 9, 13, 6, 10, 4, 8].map((h, i) => (
                <span key={i} style={{ height: h }} />
              ))}
            </div>
          </div>
        )}
        <UserCard />
      </div>
    </aside>
  );
};

const UserCard: React.FC = () => {
  const { user, isSignedIn } = useUser();
  if (!isSignedIn) {
    return (
      <Link href="/sign-in" className="user-card" style={{ textDecoration: 'none' }}>
        <div className="user-avatar">?</div>
        <div className="user-meta">
          <span className="user-name">Sign in</span>
          <span className="user-plan">to wire up your workspace</span>
        </div>
      </Link>
    );
  }
  const name = user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || 'You';
  const plan = user?.primaryEmailAddress?.emailAddress?.split('@')[1] || 'sociafy.app';
  return (
    <div className="user-card">
      <UserButton
        appearance={{ elements: { userButtonAvatarBox: { width: 32, height: 32 } } }}
      />
      <div className="user-meta" style={{ marginLeft: 4 }}>
        <span className="user-name">{name}</span>
        <span className="user-plan">Studio · {plan}</span>
      </div>
    </div>
  );
};

interface TopbarProps {
  crumbs: string[];
  mode?: Mode;
  onMode?: (m: Mode) => void;
  children?: React.ReactNode;
}

export const Topbar: React.FC<TopbarProps> = ({ crumbs, mode, onMode, children }) => (
  <div className="topbar">
    <div className="crumbs">
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="sep">/</span>}
          <span className={i === crumbs.length - 1 ? 'leaf' : 'muted'}>{c}</span>
        </Fragment>
      ))}
    </div>
    <div className="topbar-spacer" />
    <div className="topbar-actions">
      {mode !== undefined && onMode && <ModeSwitch value={mode} onChange={onMode} />}
      <div className="search">
        <Icon name="search" size={13} />
        <span>Search posts, drafts, trends…</span>
        <span className="kbd">⌘K</span>
      </div>
      <button className="btn ghost" title="Notifications">
        <Icon name="bell" size={14} />
      </button>
      {children}
    </div>
  </div>
);
