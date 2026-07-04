'use client';

import React from 'react';
import { useApi } from '../../lib/ui/fetcher';
import { Icon } from '../icons';

interface PendingResponse {
  id: string;
  title: string;
  url: string;
  source: string;
  sentimentLabel: string;
  severity: number;
  brand: string;
}
interface FailedPost {
  id: string;
  platform: string;
  text: string;
  error: string | null;
  scheduledAt: string | null;
}
export interface AttentionData {
  counts: { total: number; pendingResponses: number; crisis: number; failedPosts: number };
  pendingResponses: PendingResponse[];
  failedPosts: FailedPost[];
}

/** The "Needs your attention" queue: crisis/negative mentions awaiting a
 *  response + posts that failed to publish. onReview jumps the dashboard to the
 *  crisis filter so the user can act. */
const AttentionQueue: React.FC<{ onReview?: () => void }> = ({ onReview }) => {
  const { data } = useApi<AttentionData>('/api/shield/attention');
  const pending = data?.pendingResponses ?? [];
  const failed = data?.failedPosts ?? [];

  if (pending.length === 0 && failed.length === 0) {
    return (
      <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ink-3)' }}>
        <Icon name="check" size={22} />
        <p style={{ margin: '10px 0 0', fontSize: 13.5, fontWeight: 500, color: 'var(--ink-2)' }}>You&apos;re all caught up</p>
        <p style={{ margin: '2px 0 0', fontSize: 12.5 }}>No mentions awaiting a response and no failed posts.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {pending.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Awaiting response</span>
            <span className="mono" style={{ fontSize: 9.5, padding: '1px 6px', borderRadius: 100, background: 'oklch(0.96 0.05 25)', color: 'oklch(0.45 0.18 25)' }}>{pending.length}</span>
            {onReview && (
              <>
                <span style={{ flex: 1 }} />
                <button className="btn sm" onClick={onReview}>Review all</button>
              </>
            )}
          </div>
          {pending.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: '1px solid var(--line)', borderRadius: 'var(--r)', background: 'var(--bg)' }}>
              <span
                className="mono"
                style={{ fontSize: 9.5, padding: '2px 6px', borderRadius: 100, whiteSpace: 'nowrap', background: p.sentimentLabel === 'crisis' ? 'oklch(0.93 0.08 25)' : 'oklch(0.95 0.06 55)', color: p.sentimentLabel === 'crisis' ? 'oklch(0.42 0.2 25)' : 'oklch(0.42 0.14 55)' }}
              >
                {p.sentimentLabel} · {p.severity}/10
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
              {p.url && (
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="btn sm" title="Open source">
                  <Icon name="arrow_up_right" size={12} />
                </a>
              )}
            </div>
          ))}
        </section>
      )}

      {failed.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Failed posts</span>
            <span className="mono" style={{ fontSize: 9.5, padding: '1px 6px', borderRadius: 100, background: 'var(--bg-elev)', color: 'var(--ink-3)' }}>{failed.length}</span>
          </div>
          {failed.map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: '1px solid var(--line)', borderRadius: 'var(--r)', background: 'var(--bg)' }}>
              <span className="mono" style={{ fontSize: 9.5, padding: '2px 6px', borderRadius: 100, background: 'var(--bg-sunk)', color: 'var(--ink-2)', textTransform: 'capitalize' }}>{f.platform}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.text}</div>
                {f.error && <div style={{ fontSize: 11, color: 'oklch(0.55 0.18 25)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.error}</div>}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
};

export default AttentionQueue;
