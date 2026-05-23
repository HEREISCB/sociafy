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
 * Compact credit-balance pill for the topbar. Shows balance with a thin
 * fuel-bar; pulses amber under 15% of the monthly allocation, red under 5%.
 * Click to open a small popover with tier + quick top-up CTA.
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
      <div className="credit-meter ghost" title="Loading credits…">
        <span className="credit-meter-icon"><Icon name="bolt" size={11} /></span>
        <span className="credit-meter-amt mono">—</span>
      </div>
    );
  }

  const pct = Math.min(100, Math.max(0, Math.round((data.balance / data.monthlyAllocation) * 100)));
  const state = pct <= 5 ? 'crit' : pct <= 15 ? 'warn' : 'ok';

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className={`credit-meter ${state}`}
        onClick={() => setOpen((o) => !o)}
        title={`${data.balance.toLocaleString()} credits · ${TIER_LABEL[data.tier]}`}
      >
        <span className="credit-meter-icon"><Icon name="bolt" size={11} /></span>
        <span className="credit-meter-amt mono">{formatBalance(data.balance)}</span>
        <span className="credit-meter-bar" aria-hidden>
          <span className="fill" style={{ width: `${pct}%` }} />
        </span>
      </button>
      {open && <CreditPopover data={data} onClose={() => setOpen(false)} />}
    </div>
  );
};

const CreditPopover: React.FC<{ data: CreditsPayload; onClose: () => void }> = ({ data, onClose }) => {
  const pct = Math.min(100, Math.max(0, Math.round((data.balance / data.monthlyAllocation) * 100)));
  const cycleStart = data.creditCycleStart ? new Date(data.creditCycleStart) : null;
  const nextResetEst = cycleStart
    ? new Date(cycleStart.getTime() + 30 * 24 * 60 * 60 * 1000)
    : null;
  return (
    <div className="credit-popover">
      <div className="credit-popover-head">
        <div>
          <div className="credit-popover-tier mono">
            {TIER_LABEL[data.tier]} · {data.monthlyAllocation.toLocaleString()}/mo
          </div>
          <div className="credit-popover-balance">
            <span className="big">{data.balance.toLocaleString()}</span>
            <span className="muted"> credits left</span>
          </div>
        </div>
        <div className="credit-popover-ring" style={{ '--pct': pct } as React.CSSProperties}>
          <span className="ring-pct mono">{pct}%</span>
        </div>
      </div>

      <div className="credit-popover-bar">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="credit-popover-meta mono">
        {nextResetEst ? (
          <>Cycle resets ~ {nextResetEst.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</>
        ) : null}
      </div>

      <div className="credit-popover-actions">
        <Link href="/usage" className="btn ghost" onClick={onClose}>
          <Icon name="search" size={12} /> View usage
        </Link>
        <Link href="/billing" className="btn primary" onClick={onClose}>
          <Icon name="bolt" size={12} /> Top up
        </Link>
      </div>

      <RecentLedger ledger={data.ledger.slice(0, 6)} />
    </div>
  );
};

const RecentLedger: React.FC<{ ledger: CreditsPayload['ledger'] }> = ({ ledger }) => {
  if (ledger.length === 0) return null;
  return (
    <div className="credit-recent">
      <div className="credit-recent-head mono">Recent</div>
      {ledger.map((row) => (
        <div key={row.id} className="credit-recent-row">
          <span className="lbl">{row.label}</span>
          <span className={`val mono ${row.credits < 0 ? 'neg' : 'pos'}`}>
            {row.credits > 0 ? '+' : ''}{row.credits}
          </span>
        </div>
      ))}
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
      <Link href="/usage" className="btn ghost">View usage</Link>
      <Link href="/billing" className="btn primary">Top up</Link>
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
