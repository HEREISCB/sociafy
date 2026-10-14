'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useClerk, useUser } from '@clerk/nextjs';
import { Icon } from './icons';
import { useApi } from '../lib/ui/fetcher';
import { CreditMeter, type CreditsPayload } from './credits';
import type { AgentStatus } from '../lib/agent/status';
import { createSpring, project, rubberband, type Spring } from '../lib/ui/spring';


/**
 * AutopilotStatusPill — at-a-glance autopilot state; click jumps to /autopilot.
 * Loading reads as paused so a slow nav never flashes "on" then "paused".
 */
interface AutopilotStatusPillProps {
  onClick?: () => void;
}

export const AutopilotStatusPill: React.FC<AutopilotStatusPillProps> = ({ onClick }) => {
  const { data } = useApi<Pick<AgentStatus, 'enabled' | 'blocked' | 'pendingReview'>>('/api/agent/status', {
    refreshInterval: 60_000,
  });
  const state = !data?.enabled ? 'off' : data.blocked ? 'blocked' : 'on';
  const toReview = data?.pendingReview?.length ?? 0;
  return (
    <button type="button" className={`shell-pill ${state}`} onClick={onClick}>
      <span className="dot" aria-hidden />
      {state === 'off' && <span>Autopilot paused</span>}
      {state === 'blocked' && <span>Autopilot needs you</span>}
      {state === 'on' && (
        <span>Autopilot on{toReview > 0 && <span className="detail"> · {toReview} to review</span>}</span>
      )}
    </button>
  );
};

interface SidebarProps {
  /** When true on mobile, the sidebar slides in from the left as a drawer. */
  mobileOpen?: boolean;
  /** Called when the drawer should close (scrim click, nav, or Esc). */
  onMobileClose?: () => void;
}

const MOBILE = '(max-width: 900px)';
const REDUCED = '(prefers-reduced-motion: reduce)';
/** Below this the release was a drag, not a flick, so position decides. px/s. */
const FLICK = 150;
/** Movement before we commit to a direction — also lets a tap stay a tap. */
const HYSTERESIS = 10;
/** Apple's published drawer/sheet feel. */
const SHEET = { damping: 0.8, response: 0.3 };

type Sample = { t: number; x: number };

/** px/s from the tail of the gesture. Zero if the finger had already stopped —
 *  averaging over a stale window would invent a flick that never happened. */
function velocityFrom(samples: Sample[]): number {
  const last = samples[samples.length - 1];
  const now = performance.now();
  if (!last || now - last.t > 120) return 0;
  const first = samples.find((s) => last.t - s.t < 120) ?? samples[0];
  const dt = (last.t - first.t) / 1000;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/**
 * The mobile drawer as a real gesture rather than a scripted animation.
 *
 * Everything here exists to serve one property: the drawer can be grabbed at
 * any instant, including mid-flight, and it never jumps when you do. That is
 * why the drag anchors to `spring.value` (what is actually on screen) instead
 * of to the logical open/closed target, and why there is no CSS transition.
 *
 * Returns handlers to spread onto the <aside>, plus the two refs.
 */
function useDrawerDrag(open: boolean, onClose: () => void, onOpen: () => void) {
  const asideRef = useRef<HTMLElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const springRef = useRef<Spring | null>(null);
  const widthRef = useRef(280);
  const mountedRef = useRef(false);
  const draggedRef = useRef(false);
  const endDragRef = useRef<(() => void) | null>(null);

  // The only place anything is written to the DOM. x runs from -width (shut)
  // to 0 (open); the scrim darkens in step, so a half-drag reads as half-open.
  const paint = useCallback((x: number) => {
    asideRef.current?.style.setProperty('--drawer-x', `${x}px`);
    const scrim = scrimRef.current;
    if (scrim) {
      const p = Math.max(0, Math.min(1, 1 + x / widthRef.current));
      scrim.style.opacity = String(p);
      scrim.style.pointerEvents = p > 0.01 ? 'auto' : 'none';
    }
  }, []);

  const measure = useCallback(() => {
    const w = asideRef.current?.offsetWidth;
    if (w) widthRef.current = w;
    return widthRef.current;
  }, []);

  useEffect(() => {
    if (!asideRef.current || !window.matchMedia(MOBILE).matches) return;
    const w = measure();
    const spring = (springRef.current ??= createSpring(paint, -w));
    // First paint and reduced motion both want the value, not the journey.
    if (!mountedRef.current || window.matchMedia(REDUCED).matches) {
      mountedRef.current = true;
      spring.set(open ? 0 : -w);
      return;
    }
    // Carries whatever velocity the spring already had, so a re-target lands
    // as a redirection rather than a stop-and-restart.
    spring.to(open ? 0 : -w, SHEET);
  }, [open, measure, paint]);

  /**
   * The gesture lives entirely in this closure, and — importantly — tracks on
   * `window`, not on the <aside>. A drawer closing at 2000px/s slides out from
   * under a stationary finger in a single frame; if the moves were bound to
   * the element, that grab would be silently dropped, which is precisely the
   * interruption the whole feature exists to support.
   */
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!window.matchMedia(MOBILE).matches || window.matchMedia(REDUCED).matches) return;
    const maybeSpring = springRef.current;
    const maybeEl = asideRef.current;
    if (!maybeSpring || !maybeEl) return;
    // Re-bound as plain locals: the hoisted `move`/`up` declarations below do
    // not inherit the narrowing from the guard above.
    const spring: Spring = maybeSpring;
    const el: HTMLElement = maybeEl;
    const w = measure();
    draggedRef.current = false;

    const id = e.pointerId;
    const startY = e.clientY;
    let startX = e.clientX;
    let from = spring.value;
    let active = false;
    let samples: Sample[] = [];
    // Note: the spring is NOT stopped here. A touch that never becomes a drag
    // must leave an in-flight drawer alone rather than strand it half open.

    const end = () => {
      endDragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    };

    function move(ev: PointerEvent) {
      if (ev.pointerId !== id) return;
      if (!active) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) < HYSTERESIS && Math.abs(dy) < HYSTERESIS) return;
        // Vertical intent wins the ambiguity: the drawer scrolls instead.
        if (Math.abs(dx) <= Math.abs(dy)) { end(); return; }
        active = true;
        // Captured only now, so a touch that stays a tap still reaches the nav
        // button underneath it.
        try { el.setPointerCapture(id); } catch { /* pointer already gone */ }
        spring.stop();
        // Re-anchor to the live on-screen position at the instant of takeover.
        // This is what makes grabbing a moving drawer jump-free, and it is
        // what preserves the grab offset: the drawer moves *with* the finger
        // from here on, it is never yanked to sit under it.
        from = spring.value;
        startX = ev.clientX;
        samples = [{ t: performance.now(), x: from }];
      }
      let x = from + (ev.clientX - startX);
      // Soft bounds. Past either edge it keeps moving, just less and less.
      if (x > 0) x = rubberband(x, w);
      else if (x < -w) x = -w - rubberband(-w - x, w);
      samples.push({ t: performance.now(), x });
      if (samples.length > 8) samples.shift();
      spring.set(x);
    }

    function up(ev: PointerEvent) {
      if (ev.pointerId !== id) return;
      end();
      if (!active) return; // never became a drag; let the click through
      draggedRef.current = true;
      const v = velocityFrom(samples);
      // A flick is an instruction and its direction is the whole instruction —
      // where the drawer happened to be when the finger left is irrelevant.
      // Only when there is no meaningful velocity does position get a say, and
      // then through the projected resting point, not the release point.
      const willOpen = Math.abs(v) > FLICK ? v > 0 : spring.value + project(v) > -w / 2;
      spring.to(willOpen ? 0 : -w, { ...SHEET, velocity: v });
      // Report the outcome either way. Pulling a closing drawer back open has
      // to be a real state change, or the app would believe it is shut while
      // it is plainly on screen.
      (willOpen ? onOpen : onClose)();
    }

    endDragRef.current = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, [measure, onClose, onOpen]);

  // Unmounting mid-drag would otherwise leave the window listeners behind.
  useEffect(() => () => endDragRef.current?.(), []);

  return {
    asideRef,
    scrimRef,
    handlers: {
      onPointerDown,
      // A drag that finishes on a nav link must not also navigate. Cleared on
      // the next pointerdown so it can never eat a genuine tap.
      onClickCapture: (e: React.MouseEvent) => {
        if (!draggedRef.current) return;
        draggedRef.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
      // Native link/image dragging would steal the gesture.
      onDragStart: (e: React.DragEvent) => e.preventDefault(),
    },
  };
}

const NAV = [
  { href: '/dashboard', label: 'Home', icon: 'home' as const },
  { href: '/autopilot', label: 'Autopilot', icon: 'bolt' as const },
];

export const Sidebar: React.FC<SidebarProps> = ({ mobileOpen = false, onMobileClose }) => {
  const pathname = usePathname() ?? '';
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  // The parent's `mobileOpen` is a trigger, not the truth: a gesture can pull a
  // closing drawer back open, and the parent has no callback to hear about it.
  // So the drawer is open if the parent asked for it OR the user caught it.
  // Every close path clears the flag and tells the parent, which keeps the two
  // in step without any page needing to know a drag happened.
  const [caught, setCaught] = useState(false);
  const open = mobileOpen || caught;
  const close = useCallback(() => { setCaught(false); onMobileClose?.(); }, [onMobileClose]);
  const reopen = useCallback(() => setCaught(true), []);

  const { asideRef, scrimRef, handlers } = useDrawerDrag(open, close, reopen);

  // Auto-close drawer on Esc so a thumb-friendly escape exists alongside scrim tap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const navLink = (href: string, label: string, icon: React.ComponentProps<typeof Icon>['name']) => (
    <Link
      key={href}
      href={href}
      className={`nav-item ${isActive(href) ? 'active' : ''}`}
      aria-current={isActive(href) ? 'page' : undefined}
      onClick={close}
    >
      <Icon name={icon} className="ic" />
      {label}
    </Link>
  );

  return (
    <>
      {/* Always mounted: it has to be able to fade back OUT with the drawer,
          and to darken continuously under a drag. CSS keeps it transparent
          and click-through until the drawer actually moves. */}
      <div ref={scrimRef} className="sidebar-scrim" onClick={close} aria-hidden="true" />
      <aside ref={asideRef} {...handlers} className={`sidebar${open ? ' mobile-open' : ''}`}>
        <Link href="/" className="brand" onClick={close}>
          <div className="brand-mark">S</div>
          <span className="brand-name">sociafy<span className="dot">.</span></span>
        </Link>

        <nav className="nav-section">
          {NAV.map((it) => navLink(it.href, it.label, it.icon))}
        </nav>

        <div className="sidebar-foot">
          {navLink('/account/billing', 'Billing & usage', 'chart')}
          {navLink('/account/api', 'API keys', 'lock')}
          {navLink('/settings', 'Settings', 'settings')}
          <UserCard onNavigate={close} />
        </div>
      </aside>
    </>
  );
};

/**
 * Bottom-left account card. Opens a small menu upward with the account-level
 * pages (billing, API keys) that sit outside workspace Settings.
 */
const UserCard: React.FC<{ onNavigate?: () => void }> = ({ onNavigate }) => {
  // All hooks run before the early returns below — Clerk hydrating must not
  // change the hook count (React would throw).
  const { user, isSignedIn, isLoaded } = useUser();
  const { signOut } = useClerk();
  const { data: credits } = useApi<CreditsPayload>(isSignedIn ? '/api/credits' : null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      rootRef.current?.querySelector<HTMLElement>('.user-card')?.focus();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Until Clerk resolves auth on the client, render a stable placeholder that
  // matches the server HTML — otherwise the server ("Sign in") vs client (user
  // card) swap is a structural hydration mismatch (React #418).
  if (!isLoaded) {
    return (
      <div className="user-card" aria-hidden="true">
        <div className="user-avatar">·</div>
        <div className="user-meta">
          <span className="user-name">&nbsp;</span>
        </div>
      </div>
    );
  }
  if (!isSignedIn) {
    return (
      <Link href="/sign-in" className="user-card">
        <div className="user-avatar">?</div>
        <div className="user-meta">
          <span className="user-name">Sign in</span>
        </div>
      </Link>
    );
  }

  const email = user?.primaryEmailAddress?.emailAddress;
  const name = user?.fullName || user?.username || email || 'You';
  const go = () => { setOpen(false); onNavigate?.(); };

  return (
    <div className="user-menu-anchor" ref={rootRef}>
      {open && (
        <div className="user-menu" role="menu" aria-label="Account">
          <div className="user-menu-who">
            <div className="user-name">{name}</div>
            {email && email !== name && <div className="user-menu-email">{email}</div>}
          </div>
          <Link href="/account/billing" role="menuitem" className="user-menu-item" onClick={go}>
            <Icon name="bolt" size={14} />
            <span>Billing &amp; usage</span>
            {credits && (
              <span className="user-menu-aside">
                <span className="mono">{credits.balance.toLocaleString()}</span> credits
              </span>
            )}
          </Link>
          <Link href="/account/api" role="menuitem" className="user-menu-item" onClick={go}>
            <Icon name="lock" size={14} />
            <span>API keys</span>
          </Link>
          <Link href="/settings" role="menuitem" className="user-menu-item" onClick={go}>
            <Icon name="settings" size={14} />
            <span>Settings</span>
          </Link>
          <div className="user-menu-sep" />
          <button type="button" role="menuitem" className="user-menu-item" onClick={() => { go(); void signOut({ redirectUrl: '/' }); }}>
            <Icon name="arrow_right" size={14} />
            <span>Sign out</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className="user-card"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
      >
        <div className="user-avatar">
          {user?.imageUrl
            ? <img src={user.imageUrl} alt="" width={28} height={28} />
            : name.slice(0, 1).toUpperCase()}
        </div>
        <div className="user-meta">
          <span className="user-name">{name}</span>
        </div>
        <Icon name="more" size={14} className="user-card-more" />
      </button>
    </div>
  );
};

interface TopbarProps {
  /** Mobile hamburger handler — shows a menu button visible only at narrow
   *  viewports, wired to the sidebar-drawer open state. */
  onMenuClick?: () => void;
}

export const Topbar: React.FC<TopbarProps> = ({ onMenuClick }) => {
  const router = useRouter();
  // On /compose the page's own Schedule button is the CTA; a second "New post" would compete.
  const composing = (usePathname() ?? '').startsWith('/compose');
  return (
    <div className="topbar">
      {onMenuClick && (
        <button
          type="button"
          className="topbar-menu-btn"
          onClick={onMenuClick}
          aria-label="Open menu"
        >
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      )}
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        <AutopilotStatusPill onClick={() => router.push('/autopilot')} />
        <CreditMeter />
        <NotificationsBell />
        {!composing && (
          <Link href="/compose" className="btn primary shell-new" aria-label="New post">
            <Icon name="plus" size={14} /> <span className="shell-new-label">New post</span>
          </Link>
        )}
      </div>
    </div>
  );
};

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
    <div ref={rootRef} className="shell-pop-anchor">
      <button
        type="button"
        className="btn ghost shell-bell"
        aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
        aria-expanded={open}
        onClick={() => { setOpen((o) => !o); if (!open) markRead(); }}
      >
        <Icon name="bell" size={14} />
        {unread > 0 && <span className="unread" aria-hidden />}
      </button>
      {open && (
        <div className="shell-pop">
          <div className="shell-pop-head">Activity</div>
          {items.length === 0 ? (
            <div className="shell-pop-empty">Nothing yet.</div>
          ) : (
            items.map((a) => (
              <div key={a.id} className="shell-pop-item">
                <div className="shell-pop-title">{a.title}</div>
                {a.body && <div className="shell-pop-body">{a.body}</div>}
                <div className="shell-pop-time">{relTime(a.createdAt)}</div>
              </div>
            ))
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
