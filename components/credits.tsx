'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useApi } from '../lib/ui/fetcher';
import { Icon } from './icons';

export type CreditsPayload = {
  balance: number;
  tier: 'starter' | 'pro' | 'business';
  monthlyAllocation: number;
  creditCycleStart: string | null;
  ledger: Array<{
    id: string;
    kind: string;
    action: string | null;
    label: string;
    credits: number;
    meta: Record<string, unknown> | null;
    createdAt: string;
  }>;
};

const TIER_LABEL: Record<CreditsPayload['tier'], string> = {
  starter: 'Starter',
  pro: 'Pro',
  business: 'Business',
};

/**
 * Topbar credit balance. Quiet when healthy; turns into a warning chip under
 * 15% of the monthly allocation (red under 5%). Click for a small popover.
 */
export const CreditMeter: React.FC = () => {
  const { data } = useApi<CreditsPayload>('/api/credits', {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  if (!data) {
    return (
      <div className="credit-meter ghost" aria-hidden>
        <Icon name="bolt" size={12} />
        <span className="mono">—</span>
      </div>
    );
  }

  const pct = percentLeft(data);
  const state = pct <= 5 ? 'crit' : pct <= 15 ? 'warn' : 'ok';

  return (
    <div ref={ref} className="shell-pop-anchor">
      <button
        type="button"
        className={`credit-meter ${state}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${data.balance.toLocaleString()} credits left`}
      >
        <Icon name="bolt" size={12} />
        {state !== 'ok' && <span className="credit-meter-low">Low</span>}
        <span className="mono">{formatBalance(data.balance)}</span>
      </button>
      {open && <CreditPopover data={data} onClose={() => setOpen(false)} />}
    </div>
  );
};

function percentLeft(data: CreditsPayload): number {
  if (!data.monthlyAllocation) return 0;
  return Math.min(100, Math.max(0, Math.round((data.balance / data.monthlyAllocation) * 100)));
}

const CreditPopover: React.FC<{ data: CreditsPayload; onClose: () => void }> = ({ data, onClose }) => {
  const pct = percentLeft(data);
  const cycleStart = data.creditCycleStart ? new Date(data.creditCycleStart) : null;
  const nextResetEst = cycleStart
    ? new Date(cycleStart.getTime() + 30 * 24 * 60 * 60 * 1000)
    : null;
  return (
    <div className="credit-popover">
      <div className="credit-popover-tier">
        {TIER_LABEL[data.tier]} · {data.monthlyAllocation.toLocaleString()} / month
      </div>
      <div className="credit-popover-balance">
        <span className="mono">{data.balance.toLocaleString()}</span> credits left
      </div>
      <div className="meter-bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
      {nextResetEst && (
        <div className="credit-popover-meta">
          Resets {nextResetEst.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </div>
      )}
      <div className="credit-popover-actions">
        <Link href="/settings/plan" className="btn ghost sm" onClick={onClose}>Plan &amp; usage</Link>
        <Link href="/settings/plan?topup=1" className="btn primary sm" onClick={onClose}>Top up</Link>
      </div>
    </div>
  );
};

function formatBalance(n: number): string {
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

/**
 * Small inline banner for surfacing an `insufficient_credits` 402 response.
 * Use in compose / agent / calendar forms — render when an apiPost throws
 * an error whose .message contains "402".
 */
export const InsufficientCreditsBanner: React.FC<{
  balance?: number;
  needed?: number;
  onDismiss?: () => void;
}> = ({ balance, needed, onDismiss }) => (
  <div className="insufficient-credits-banner">
    <div className="icon"><Icon name="bolt" size={14} /></div>
    <div className="copy">
      <strong>Out of credits.</strong>
      <span className="muted">
        {typeof needed === 'number' && typeof balance === 'number'
          ? ` ${needed} credits needed · ${balance} remaining.`
          : ' Top up or upgrade your plan to keep generating.'}
      </span>
    </div>
    <div className="actions">
      <Link href="/settings/plan" className="btn ghost">View usage</Link>
      <Link href="/settings/plan?topup=1" className="btn primary">Top up</Link>
      {onDismiss && (
        <button className="btn ghost icon-only" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  </div>
);

/** Parse an apiPost-style error into a typed insufficient-credits payload, or null. */
export function parseInsufficientCredits(err: unknown): { balance: number; needed: number } | null {
  if (!(err instanceof Error)) return null;
  if (!err.message.includes('402')) return null;
  try {
    const jsonStart = err.message.indexOf('{');
    if (jsonStart === -1) return null;
    const parsed = JSON.parse(err.message.slice(jsonStart));
    if (parsed?.error === 'insufficient_credits') {
      return { balance: Number(parsed.balance ?? 0), needed: Number(parsed.needed ?? 0) };
    }
  } catch {
    // fall through
  }
  return null;
}
