'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useClerk, useUser } from '@clerk/nextjs';
import { Icon } from './icons';
import { useApi } from '../lib/ui/fetcher';
import { CreditMeter, type CreditsPayload } from './credits';
import { useDismiss, useToast } from './ui';
import type { AgentBlock, AgentStatus } from '../lib/agent/status';
import { createSpring, project, rubberband, type Spring } from '../lib/ui/spring';
import { ACCOUNT, NAV } from '../lib/ui/nav';

type StatusPayload = Pick<AgentStatus, 'enabled' | 'blocked' | 'pendingReview' | 'nextPostAt'>;
/** One key for the pill and the nav count, so SWR fetches it once. */
const useAgentStatus = () => useApi<StatusPayload>('/api/agent/status', { refreshInterval: 60_000 });

const BLOCKED: Record<AgentBlock, string> = {
  no_niches: 'Add the topics you post about before Autopilot can plan',
  no_platforms: 'Connect an account before Autopilot can post',
  no_credits: 'Out of credits: Autopilot can’t plan new posts',
  credit_cap: 'This month’s Autopilot credit cap is reached',
  no_trends: 'Waiting for fresh trends to write about',
};

/**
 * AutopilotStatus: state only — on, paused, needs you, or loading (a neutral
 * dot, never a false "paused"). The title says why; click opens /autopilot.
 * On phones the words collapse to the dot and the aria-label keeps them.
 */
export const AutopilotStatusPill: React.FC<{ onClick?: () => void }> = ({ onClick }) => {
  const { data, error } = useAgentStatus();
  // undefined = not fetched yet (same on the server and first client render).
  const state = data === undefined && !error ? 'loading' : !data?.enabled ? 'paused' : data.blocked ? 'blocked' : 'on';
  const label = { loading: 'Autopilot', paused: 'Autopilot paused', blocked: 'Autopilot needs you', on: 'Autopilot on' }[state];
  const title = state === 'loading' ? 'Checking Autopilot…'
    : state === 'paused' ? 'Paused: nothing new will be drafted'
    : state === 'blocked' && data?.blocked ? BLOCKED[data.blocked]
    : data?.nextPostAt ? `Autopilot is on. Next post ${new Date(data.nextPostAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
    : 'Autopilot is on';
  return (
    <button type="button" className="shell-pill" data-state={state} onClick={onClick} title={title} aria-label={state === 'loading' ? 'Autopilot status loading' : label}>
      <span className="dot" aria-hidden />
      <span className="lbl">{label}</span>
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

/** The phone topbar names the page you're on. */
const PLACES: [string, string][] = [
  ...NAV.map((n): [string, string] => [n.href, n.label]),
  ...ACCOUNT.map((n): [string, string] => [n.href, n.label]),
  ['/compose', 'New post'],
];
const isUnder = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

export const Sidebar: React.FC<SidebarProps> = ({ mobileOpen = false, onMobileClose }) => {
  const pathname = usePathname() ?? '';
  const isActive = (href: string) => isUnder(pathname, href);
  const { data: status } = useAgentStatus();
  const toReview = status?.pendingReview?.length ?? 0;

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

  // One --subtle pill slides to the active destination (transform only).
  const navRef = useRef<HTMLElement | null>(null);
  const indRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const ind = indRef.current;
    if (!nav || !ind) return;
    const place = () => {
      const on = nav.querySelector<HTMLElement>('.nav-item.active');
      if (!on) { nav.removeAttribute('data-ready'); return; }
      ind.style.height = `${on.offsetHeight}px`;
      ind.style.transform = `translateY(${on.offsetTop}px)`;
      requestAnimationFrame(() => nav.setAttribute('data-ready', ''));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [pathname]);

  const navLink = (href: string, label: string, icon: React.ComponentProps<typeof Icon>['name'], count?: number) => (
    <Link
      key={href}
      href={href}
      className={`nav-item ${isActive(href) ? 'active' : ''}`}
      aria-current={isActive(href) ? 'page' : undefined}
      onClick={close}
    >
      <Icon name={icon} className="ic" />
      {label}
      {count ? <span className="count" title={`${count} ${count === 1 ? 'post' : 'posts'} to review`}>{count}</span> : null}
    </Link>
  );

  return (
    <>
      {/* Always mounted: it has to be able to fade back OUT with the drawer,
          and to darken continuously under a drag. CSS keeps it transparent
          and click-through until the drawer actually moves. */}
      <div ref={scrimRef} className="sidebar-scrim" onClick={close} aria-hidden="true" />
      <aside ref={asideRef} {...handlers} className={`sidebar${open ? ' mobile-open' : ''}`} aria-label="Main">
        <Link href="/dashboard" className="brand" onClick={close} aria-label="Sociafy, This week">
          <div className="brand-mark" aria-hidden="true">S</div>
          <span className="brand-name">sociafy<span className="dot">.</span></span>
        </Link>

        <nav ref={navRef} className="nav-section" aria-label="Workspace">
          <span ref={indRef} className="nav-ind" aria-hidden="true" />
          {NAV.map((it) => navLink(it.href, it.label, it.icon, it.href === '/dashboard' ? toReview : undefined))}
        </nav>

        <div className="sidebar-foot">
          <nav className="nav-section" aria-label="Account">
            <div className="nav-label" aria-hidden="true">Account</div>
            {ACCOUNT.map((it) => navLink(it.href, it.label, it.icon))}
          </nav>
          <UserCard onNavigate={close} />
        </div>
      </aside>
    </>
  );
};

const TIERS: Record<CreditsPayload['tier'], string> = { starter: 'Starter', pro: 'Pro', business: 'Business' };

/**
 * Bottom-left account card. Its menu is identity only — who you're signed in
 * as, your plan and credits, support, sign out. The destinations are in the
 * sidebar right above it.
 */
const UserCard: React.FC<{ onNavigate?: () => void }> = ({ onNavigate }) => {
  // All hooks run before the early returns below — Clerk hydrating must not
  // change the hook count (React would throw).
  const { user, isSignedIn, isLoaded } = useUser();
  const { signOut } = useClerk();
  const { data: credits } = useApi<CreditsPayload>(isSignedIn ? '/api/credits' : null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  useDismiss(rootRef, open, closeMenu);

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
        <div className="pop menu user-menu" role="menu" aria-label="Account">
          <div className="user-menu-who">
            <div className="user-name">{name}</div>
            {email && email !== name && <div className="user-menu-email">{email}</div>}
          </div>
          <Link href="/account/billing" role="menuitem" className="menu-item" onClick={go}>
            <Icon name="bolt" size={14} />
            <span>{credits ? `${TIERS[credits.tier] ?? 'Your'} plan` : 'Plan'}</span>
            {credits && (
              <span className="menu-aside">
                <span className="mono">{credits.balance.toLocaleString()}</span> cr
              </span>
            )}
          </Link>
          <a href="mailto:support@sociafy.app" role="menuitem" className="menu-item" onClick={go}>
            <Icon name="send" size={14} />
            <span>Contact support</span>
          </a>
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => { go(); void signOut({ redirectUrl: '/' }); }}>
            <Icon name="log_out" size={14} />
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
  /** Mobile hamburger handler — the button shows only at narrow viewports. */
  onMenuClick?: () => void;
  /** Whether the mobile drawer is open (for aria-expanded). */
  menuOpen?: boolean;
}

export const Topbar: React.FC<TopbarProps> = ({ onMenuClick, menuOpen = false }) => {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  // On /compose the page's own Schedule button is the CTA; a second "New post" would compete.
  const composing = pathname.startsWith('/compose');
  const where = PLACES.find(([href]) => isUnder(pathname, href))?.[1];
  return (
    <header className="topbar">
      {onMenuClick && (
        <button
          type="button"
          className="icon-btn topbar-menu-btn"
          onClick={onMenuClick}
          aria-label="Open menu"
          aria-expanded={menuOpen}
        >
          <Icon name="list" size={18} />
        </button>
      )}
      {where && <span className="topbar-where">{where}</span>}
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        <AutopilotStatusPill onClick={() => router.push('/autopilot')} />
        <CreditMeter />
        <NotificationsBell />
        {!composing && (
          <Link href="/compose" className="btn primary shell-new" aria-label="New post">
            <Icon name="plus" size={14} /> <span className="lbl">New post</span>
          </Link>
        )}
      </div>
    </header>
  );
};

type ActivityItem = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  meta?: Record<string, unknown> | null;
  createdAt: string;
};

/** Where a notification takes you: the page where you can act on it. */
function activityHref(kind: string): string {
  if (kind.startsWith('platform_')) return '/settings/connections';
  if (kind.startsWith('shield_')) return '/settings/mentions';
  if (kind === 'agent_enabled' || kind === 'agent_disabled' || kind === 'agent_skipped' || kind === 'agent_held') return '/autopilot';
  return '/dashboard';
}

function activityTone(kind: string): { tone: '' | 'ok' | 'warn' | 'err'; icon: React.ComponentProps<typeof Icon>['name'] } {
  if (kind === 'publish_failed') return { tone: 'err', icon: 'x' };
  if (kind === 'platform_refresh_failed' || kind === 'platform_disconnected' || kind === 'publish_warning' || kind === 'agent_held' || kind === 'agent_skipped') return { tone: 'warn', icon: 'alert' };
  if (kind === 'manual_publish' || kind === 'auto_publish' || kind === 'platform_connected') return { tone: 'ok', icon: 'check' };
  if (kind === 'draft_scheduled') return { tone: '', icon: 'clock' };
  if (kind.startsWith('agent_') || kind === 'trend_spotted') return { tone: '', icon: 'sparkle' };
  return { tone: '', icon: 'bell' };
}

const SEEN_KEY = 'sociafy:lastSeenNotif';

/**
 * Activity bell. Items stay grouped as New while the panel is open and are
 * marked read when it closes, so nothing changes under your eyes. Every row
 * links to where you can act on it. Unread state is per device (localStorage).
 */
const NotificationsBell: React.FC = () => {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<number>(() => {
    if (typeof window === 'undefined') return Date.now();
    const v = window.localStorage.getItem(SEEN_KEY);
    return v ? Number(v) : 0;
  });
  /** lastSeen as it was when the panel opened: decides New vs Earlier while open. */
  const [seenAtOpen, setSeenAtOpen] = useState(0);
  const { data } = useApi<ActivityItem[]>('/api/activity?limit=15');
  const rootRef = useRef<HTMLDivElement | null>(null);

  const markSeen = useCallback((t: number) => {
    setLastSeen(t);
    window.localStorage.setItem(SEEN_KEY, String(t));
  }, []);
  const close = useCallback(() => { setOpen(false); markSeen(Date.now()); }, [markSeen]);
  useDismiss(rootRef, open, close);

  const items = data ?? [];
  const isNew = (a: ActivityItem, since: number) => new Date(a.createdAt).getTime() > since;
  const unread = items.filter((a) => isNew(a, lastSeen)).length;
  const fresh = items.filter((a) => isNew(a, seenAtOpen));
  const earlier = items.filter((a) => !isNew(a, seenAtOpen));

  const markAll = () => {
    const prev = lastSeen;
    const now = Date.now();
    markSeen(now);
    setSeenAtOpen(now);
    toast('Marked all read', { undo: () => { markSeen(prev); setSeenAtOpen(prev); } });
  };

  const row = (a: ActivityItem) => {
    const { tone, icon } = activityTone(a.kind);
    return (
      <Link key={a.id} href={activityHref(a.kind)} className={`notif-item${isNew(a, seenAtOpen) ? ' unread' : ''}`} onClick={close}>
        <span className={`notif-k ${tone}`} aria-hidden="true"><Icon name={icon} size={14} /></span>
        <span>
          <span className="notif-t">{a.title}</span>
          {a.body && <span className="notif-b">{a.body}</span>}
        </span>
        <time className="notif-tm" dateTime={a.createdAt}>{relTime(a.createdAt)}</time>
      </Link>
    );
  };

  return (
    <div ref={rootRef} className="shell-pop-anchor">
      <button
        type="button"
        className="icon-btn shell-bell"
        aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => { if (open) close(); else { setSeenAtOpen(lastSeen); setOpen(true); } }}
      >
        <Icon name="bell" size={16} />
        {unread > 0 && <span className="n" aria-hidden>{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="pop notif" role="dialog" aria-label="Activity">
          <div className="notif-head">
            <span>Activity</span>
            <button type="button" className="btn ghost sm" disabled={!fresh.length} title={fresh.length ? undefined : 'Nothing new'} onClick={markAll}>
              Mark all read
            </button>
          </div>
          <div className="notif-list">
            {!items.length ? (
              <div className="empty">
                <span className="ico" aria-hidden="true"><Icon name="bell" /></span>
                <h3>All quiet</h3>
                <p>Posts, failures and reconnect warnings show up here.</p>
              </div>
            ) : (
              <>
                {fresh.length > 0 && <div className="notif-group">New</div>}
                {fresh.map(row)}
                {earlier.length > 0 && <div className="notif-group">Earlier</div>}
                {earlier.map(row)}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr`;
  return `${Math.floor(diff / 86_400_000)} d`;
}
