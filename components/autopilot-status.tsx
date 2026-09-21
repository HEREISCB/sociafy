'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from './icons';
import type { AgentStatus } from '../lib/agent/status';

/** AgentStatus as it arrives over JSON — Dates are strings by then. */
export type AgentStatusPayload = Omit<AgentStatus, 'pendingReview'> & {
  pendingReview: { id: string; title: string | null; createdAt: string; rendering: boolean }[];
};

// Threshold the "Post automatically" button sets. Guardrails can tighten it.
const AUTO_THRESHOLD = 80;

const BLOCKED: Record<NonNullable<AgentStatus['blocked']>, { text: string; href?: string; cta?: string }> = {
  no_niches: { text: 'It has nothing to write about yet — pick your niches first.', href: '/onboarding', cta: 'Finish setup' },
  no_platforms: { text: 'It has nowhere to post — no connected account is switched on. Turn one on under Autopilot rules, or connect one.', href: '/connections', cta: 'Connections' },
  no_credits: { text: 'You are out of credits. Drafting resumes as soon as you top up.', href: '/billing', cta: 'Top up' },
  no_trends: { text: 'Nothing fresh in your niches right now. It looks again every hour and drafts as soon as something turns up.' },
  credit_cap: { text: 'It hit your weekly credit cap. Drafting resumes as older spend ages out — or raise the cap below.' },
};

function countdown(to: number, now: number): string {
  const mins = Math.max(0, Math.round((to - now) / 60_000));
  if (mins < 1) return 'any minute now';
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return 'in ' + [d && `${d}d`, h && `${h}h`, !d && m && `${m}m`].filter(Boolean).join(' ');
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

const label: React.CSSProperties = { fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 };
const row: React.CSSProperties = { padding: '12px 16px', borderTop: '1px solid var(--line)' };

interface Props {
  status: AgentStatusPayload | null | undefined;
  autopilot: boolean;
  /** True for the minute after switching on, while the first draft is being written. */
  starting: boolean;
  disabled: boolean;
  disabledReason?: string;
  onToggle: (next: boolean) => void;
  onMode: (threshold: number) => void;
  onCap: (cap: number | null) => void;
  onEditDraft?: (id: string) => void;
}

export const AutopilotStatus: React.FC<Props> = ({ status, autopilot, starting, disabled, disabledReason, onToggle, onMode, onCap, onEditDraft }) => {
  // Re-render every 30s so the countdown moves without refetching.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const blocked = autopilot && status?.blocked ? BLOCKED[status.blocked] : null;
  const auto = status?.mode === 'auto';
  const pending = status?.pendingReview ?? [];

  return (
    <div className="card" style={{ opacity: disabled && !autopilot ? 0.6 : 1 }}>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 16, alignItems: 'center' }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: autopilot ? 'var(--ink)' : 'var(--bg-sunk)', color: autopilot ? 'var(--accent)' : 'var(--ink-3)', display: 'grid', placeItems: 'center', position: 'relative' }}>
          <Icon name="bolt" size={18} />
          {autopilot && <span style={{ position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: '50%', background: blocked ? 'var(--warn)' : 'var(--good)', border: '2px solid var(--bg-elev)' }} />}
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 550, letterSpacing: '-0.01em', marginBottom: 2 }}>
            Autopilot is {!autopilot ? 'paused' : blocked ? 'stuck' : 'running'}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
            {!autopilot
              ? 'Nothing is drafted or posted until you resume.'
              : blocked ? blocked.text
              : 'It picks a trend from your niches, writes the post in your voice — with an image or video when your content mix calls for one — and ' + (auto ? 'posts it for you.' : 'hands it to you to approve.')}
            {blocked?.href && <> <Link href={blocked.href} style={{ textDecoration: 'underline', color: 'var(--ink)' }}>{blocked.cta}</Link></>}
          </div>
        </div>
        <button className={`btn ${autopilot ? '' : 'primary'}`} onClick={() => onToggle(!autopilot)} disabled={disabled} title={disabledReason}>
          {autopilot ? <><Icon name="pause" size={12} /> Pause</> : <><Icon name="play" size={12} /> Resume</>}
        </button>
      </div>

      {status && (
        <>
          {autopilot && !blocked && (
            <div style={row}>
              <div style={label}>Next draft</div>
              {starting ? (
                <div style={{ fontSize: 13 }}><Icon name="refresh" size={11} /> Writing your first draft now — usually under a minute.</div>
              ) : status.nextDraftAt ? (
                <div style={{ fontSize: 13 }}>
                  <strong>{countdown(new Date(status.nextDraftAt).getTime(), now)}</strong>
                  <span style={{ color: 'var(--ink-3)' }}> · around {when(status.nextDraftAt)} · {status.nextKind === 'text' ? 'a text' : status.nextKind === 'image' ? 'an image' : 'a video'} post, {status.nextCost} credits · {status.draftsThisWeek} of {status.cadencePerWeek} drafted this week</span>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>Post cadence is 0 — raise it under Guardrails.</div>
              )}
            </div>
          )}

          <div style={row}>
            <div style={label}>Do I have to approve posts?</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <span className={`prompt-chip ${auto ? 'active' : ''}`} onClick={() => !disabled && !auto && onMode(AUTO_THRESHOLD)}>
                <Icon name="bolt" size={11} /> No — post automatically
              </span>
              <span className={`prompt-chip ${auto ? '' : 'active'}`} onClick={() => !disabled && auto && onMode(101)}>
                <Icon name="edit" size={11} /> Yes — ask me first
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
              {auto
                ? `Drafts the AI scores ${status.threshold}+ out of 100 are scheduled for the next good posting time and go out on their own. Weaker ones wait here for your OK.`
                : 'Nothing goes out without you. Every draft waits here until you open it and schedule it.'}
            </div>
          </div>

          <div style={row}>
            <div style={label}>Waiting for your review · {pending.length}</div>
            {pending.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                No drafts waiting. {auto ? 'Auto-posted ones show up on your ' : 'Approved ones show up on your '}
                {/* Plain <a>: the dashboard reads ?tab= on load only, so a soft nav wouldn't switch tabs. */}
                <a href="/dashboard?tab=calendar" style={{ textDecoration: 'underline', color: 'var(--ink)' }}>calendar</a>.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {pending.map((d) => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg-sunk)', borderRadius: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title || 'Untitled draft'}</span>
                    {d.rendering && <span className="chip warn" style={{ fontSize: 10 }}><span className="dot" />video rendering</span>}
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{when(d.createdAt)}</span>
                    <button className="btn sm" onClick={() => onEditDraft?.(d.id)}>Review</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ ...row, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={label}>Next post going out</div>
              <div style={{ fontSize: 13 }}>
                {status.nextPostAt
                  ? <><strong>{countdown(new Date(status.nextPostAt).getTime(), now)}</strong> <span style={{ color: 'var(--ink-3)' }}>· {when(status.nextPostAt)}</span></>
                  : <span style={{ color: 'var(--ink-3)' }}>Nothing queued yet.</span>}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={label}>Weekly credit cap</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <input
                  type="number"
                  min={0}
                  // Uncontrolled; the key resets it when the saved value changes.
                  key={String(status.weeklyCreditCap)}
                  defaultValue={status.weeklyCreditCap ?? ''}
                  placeholder="No cap"
                  disabled={disabled}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    const cap = v === '' ? null : Math.max(0, parseInt(v, 10) || 0);
                    if (cap !== status.weeklyCreditCap) onCap(cap);
                  }}
                  style={{ width: 84, padding: '4px 8px', border: '1px solid var(--line-2)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 12 }}
                />
                <span style={{ color: 'var(--ink-3)' }}>
                  {status.creditsThisWeek} spent this week · your plan needs ~{status.weeklyNeed}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
