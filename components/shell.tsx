'use client';

import React, { useEffect, useRef, useState, Fragment } from 'react';
import Link from 'next/link';
import { UserButton, useUser } from '@clerk/nextjs';
import { Icon } from './icons';
import { useApi } from '../lib/ui/fetcher';

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
      <NotificationsBell />
      {children}
    </div>
  </div>
);

type ActivityItem = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  createdAt: string;
};

const NotificationsBell: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<number>(() => {
    if (typeof window === 'undefined') return Date.now();
    const v = window.localStorage.getItem('sociafy:lastSeenNotif');
    return v ? Number(v) : 0;
  });
  const { data } = useApi<ActivityItem[]>('/api/activity?limit=15');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  const items = data ?? [];
  const unread = items.filter((a) => new Date(a.createdAt).getTime() > lastSeen).length;

  const markRead = () => {
    const now = Date.now();
    setLastSeen(now);
    if (typeof window !== 'undefined') window.localStorage.setItem('sociafy:lastSeenNotif', String(now));
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        className="btn ghost"
        title="Notifications"
        onClick={() => { setOpen((o) => !o); if (!open) markRead(); }}
        style={{ position: 'relative' }}
      >
        <Icon name="bell" size={14} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2,
            minWidth: 14, height: 14, padding: '0 4px',
            background: 'var(--accent)', color: 'white',
            borderRadius: 999, fontSize: 9.5, fontWeight: 600,
            display: 'grid', placeItems: 'center', lineHeight: 1,
            fontFamily: 'var(--mono)',
          }}>{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0,
          width: 360, maxHeight: 480, overflow: 'auto',
          background: 'var(--bg-elev)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          boxShadow: '0 20px 50px -20px rgba(0,0,0,0.25)',
          zIndex: 60,
        }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 13, letterSpacing: '-0.01em' }}>Activity</strong>
            <span className="chip ghost mono" style={{ fontSize: 10 }}>{items.length}</span>
          </div>
          {items.length === 0 ? (
            <div style={{ padding: 18, fontSize: 13, color: 'var(--ink-3)' }}>
              Nothing yet. Activity from your agent + publishing will land here.
            </div>
          ) : (
            <div>
              {items.map((a) => (
                <div key={a.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.4 }}>{a.title}</div>
                  {a.body && (
                    <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.body}</div>
                  )}
                  <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 4 }}>{relTime(a.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}
