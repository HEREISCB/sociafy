'use client';

import React from 'react';
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

/**
 * Topbar credit balance. Quiet when healthy; turns into a warning chip under
 * 15% of the monthly allocation (red under 5%). Click goes to Billing & usage.
 */
export const CreditMeter: React.FC = () => {
  const { data } = useApi<CreditsPayload>('/api/credits', {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });

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
    <Link
      href="/account/billing"
      className={`credit-meter ${state}`}
      aria-label={`${data.balance.toLocaleString()} credits left. Billing and usage`}
    >
      <Icon name="bolt" size={12} />
      {state !== 'ok' && <span className="credit-meter-low">Low</span>}
      <span className="mono">{formatBalance(data.balance)}</span>
    </Link>
  );
};

function percentLeft(data: CreditsPayload): number {
  if (!data.monthlyAllocation) return 0;
  return Math.min(100, Math.max(0, Math.round((data.balance / data.monthlyAllocation) * 100)));
}

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
      <Link href="/account/billing" className="btn ghost">View usage</Link>
      <Link href="/account/billing?topup=1" className="btn primary">Top up</Link>
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
