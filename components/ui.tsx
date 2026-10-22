'use client';

/**
 * Shared React primitives. The class layer lives in app/styles/primitives.css;
 * these wrappers only add behaviour (measuring, timers, dialogs, dismissal).
 */

import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icons';

type IconName = React.ComponentProps<typeof Icon>['name'];

/* ---------- Seg ---------- */

/**
 * Segmented control: the app's .mode-switch with one ink indicator that
 * slides between options (a clip-path transition, so nothing reflows).
 */
export function Seg<T extends string>({ value, options, onChange, label: name, size, className = '' }: {
  value: T;
  options: readonly { id: T; label: React.ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  /** Accessible name of the group. */
  label: string;
  size?: 'sm';
  className?: string;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const ind = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    const bar = ind.current;
    if (!el || !bar) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!on || !el.clientWidth) return;
      const l = on.offsetLeft - 3;
      bar.style.clipPath = `inset(0 ${el.clientWidth - 6 - l - on.offsetWidth}px 0 ${l}px round 999px)`;
      // First placement lands without sliding in from the edge.
      requestAnimationFrame(() => el.setAttribute('data-ready', ''));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return (
    <div ref={root} className={`mode-switch seg${size ? ` ${size}` : ''} ${className}`} role="radiogroup" aria-label={name}>
      <span ref={ind} className="seg-ind" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={`opt${value === o.id ? ' active' : ''}`} disabled={o.disabled} title={o.title} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Button ---------- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'lg';
  /** Credits this action spends; rendered as "n cr". */
  cost?: number;
  /** Shows a spinner, sets aria-busy and blocks clicks. Change the label yourself ("Generating…"). */
  busy?: boolean;
  /** Why it's disabled. Shown next to the button (and as its title) only while disabled. */
  reason?: string;
};

/** A .btn that knows its price, its busy state and why it can't be pressed. Never hide it — disable it with a reason. */
export function Button({ variant, size, cost, busy, reason, disabled, className, children, type = 'button', title, ...rest }: ButtonProps) {
  const whyId = useId();
  const why = disabled && reason ? reason : null;
  return (
    <>
      <button
        {...rest}
        type={type}
        className={['btn', variant, size, className].filter(Boolean).join(' ')}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={why ? whyId : rest['aria-describedby']}
        title={why ?? title}
      >
        {busy && <span className="spin" aria-hidden="true" />}
        {children}
        {cost != null && !busy && <span className="cost">{cost} cr</span>}
      </button>
      {why && <span id={whyId} className="why">{why}</span>}
    </>
  );
}

/* ---------- Page header ---------- */

/** h1 + one-line sub + the page's primary action(s), reachable without scrolling. */
export function PageHeader({ title, sub, actions }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

/* ---------- Pinned action bar ---------- */

/**
 * The screen's primary actions, stuck to the bottom of .page. Publishes its
 * height as --pinbar-h so toasts and drawers stop above it.
 */
export function PinBar({ msg, children }: { msg?: React.ReactNode; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement.style;
    const ro = new ResizeObserver(() => root.setProperty('--pinbar-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => { ro.disconnect(); root.removeProperty('--pinbar-h'); };
  }, []);
  return (
    <div ref={ref} className="pinbar">
      {msg != null && <p className="msg" role="status">{msg}</p>}
      <div className="btns">{children}</div>
    </div>
  );
}

/* ---------- Toast ---------- */

type ToastOpts = { undo?: () => void; tone?: 'err' };
type ToastFn = (msg: string, opts?: ToastOpts) => void;
type ToastState = { id: number; msg: string; closing?: boolean } & ToastOpts;

const ToastCtx = createContext<ToastFn>(() => {});
/** `const toast = useToast(); toast('Caption replaced', { undo: () => setCaption(prev) })` */
export const useToast = () => useContext(ToastCtx);

/** One toast at a time, 5 s, the newest replaces the old. Mounted once in the workspace layout. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [t, setT] = useState<ToastState | null>(null);
  const seq = useRef(0);
  const toast = useCallback<ToastFn>((msg, opts) => setT({ id: ++seq.current, msg, ...opts }), []);
  const close = useCallback(() => setT((c) => (c && !c.closing ? { ...c, closing: true } : c)), []);
  useEffect(() => {
    if (!t) return;
    // Visible for 5 s; once closing, 200 ms for the fade before it's gone.
    const h = setTimeout(() => (t.closing ? setT(null) : close()), t.closing ? 200 : 5_000);
    return () => clearTimeout(h);
  }, [t, close]);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {t && (
          <div key={t.id} className={`toast${t.tone === 'err' ? ' err' : ''}`} data-closing={t.closing || undefined}>
            <span>{t.msg}</span>
            {t.undo && <button type="button" onClick={() => { t.undo?.(); close(); }}>Undo</button>}
            <button type="button" className="x" aria-label="Dismiss" onClick={close}><Icon name="x" size={14} /></button>
          </div>
        )}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Empty state · skeleton ---------- */

export function Empty({ icon, title, children, action }: { icon?: IconName; title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      {icon && <span className="ico" aria-hidden="true"><Icon name={icon} /></span>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** A placeholder the size of what's coming. */
export function Skeleton({ w, h, className = '', style }: { w?: number | string; h?: number | string; className?: string; style?: React.CSSProperties }) {
  return <span className={`skel ${className}`} aria-hidden="true" style={{ width: w, height: h, ...style }} />;
}

/* ---------- Modal · Drawer (native <dialog>) ---------- */

type SheetProps = { open: boolean; onClose: () => void; title: React.ReactNode; footer?: React.ReactNode; children?: React.ReactNode };

function Sheet({ kind, open, onClose, title, footer, children }: SheetProps & { kind: 'modal' | 'drawer' }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    // Esc fires `close`; a press on the backdrop lands on the <dialog> itself.
    <dialog ref={ref} className={kind} aria-labelledby={titleId} onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {open && (
        <>
          <div className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

/** Centered dialog. Esc, focus trap and an inert page come from showModal(). */
export const Modal = (p: SheetProps) => <Sheet kind="modal" {...p} />;
/** Right-side panel on the same <dialog> base. It covers a pinned bar; use your own panel if the bar must stay usable. */
export const Drawer = (p: SheetProps) => <Sheet kind="drawer" {...p} />;

/* ---------- Popover dismissal ---------- */

/**
 * Closes a popover on Escape or a press outside `ref`, and on Escape returns
 * focus to the trigger (the element with aria-expanded inside `ref`).
 */
export function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const cb = useRef(onClose);
  useEffect(() => { cb.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) cb.current(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture phase: the popover closes before anything behind it (the drawer) hears Esc.
      e.stopPropagation();
      cb.current();
      ref.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [ref, open]);
}

/* ---------- Back ---------- */

/** history.back(), or `fallback` when there's nothing to go back to. */
export function BackButton({ fallback = '/', className = 'btn ghost' }: { fallback?: string; className?: string }) {
  const router = useRouter();
  return (
    <button type="button" className={className} onClick={() => (window.history.length > 1 ? router.back() : router.push(fallback))}>
      <Icon name="chevron_left" size={14} /> Go back
    </button>
  );
}
