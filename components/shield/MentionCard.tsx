'use client';

import React, { useState } from 'react';
import { Icon } from '../icons';
import type { MentionSource, SentimentLabel } from '../../lib/db/schema';

export type ShieldActionRow = {
  id: string;
  status: string;
  script: string;
  targetPlatform: string | null;
  createdAt: string;
  mention: {
    id: string;
    brand: string;
    source: MentionSource;
    url: string;
    title: string;
    body: string;
    author: string;
    engagement: number;
    sentimentLabel: SentimentLabel;
    severity: number;
    theme: string;
    crisisWords: string[] | null;
    negWords: string[] | null;
    fetchedAt: string;
  };
};

const LABEL_STYLE: Record<SentimentLabel, { bg: string; color: string; label: string }> = {
  crisis: {
    bg: 'oklch(0.95 0.07 25)',
    color: 'oklch(0.38 0.18 25)',
    label: 'Crisis',
  },
  negative: {
    bg: 'oklch(0.96 0.06 50)',
    color: 'oklch(0.42 0.14 50)',
    label: 'Negative',
  },
  neutral: {
    bg: 'var(--bg-sunk)',
    color: 'var(--ink-3)',
    label: 'Neutral',
  },
  positive: {
    bg: 'oklch(0.95 0.06 145)',
    color: 'oklch(0.38 0.12 145)',
    label: 'Positive',
  },
};

const SOURCE_LABEL: Record<string, string> = {
  google_news: 'News',
  hackernews: 'HN',
  wikipedia: 'Wikipedia',
  reddit: 'Reddit',
  x: 'X',
  linkedin: 'LinkedIn',
  own_post: 'Own Post',
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface Props {
  row: ShieldActionRow;
  onApprove: (id: string, script: string, targetPlatform: string | null) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  connectedPlatforms: string[];
}

export const MentionCard: React.FC<Props> = ({ row, onApprove, onReject, connectedPlatforms }) => {
  const [expanded, setExpanded] = useState(row.mention.sentimentLabel === 'crisis');
  const [script, setScript] = useState(row.script);
  const [platform, setPlatform] = useState<string>(row.targetPlatform ?? '');
  const [busy, setBusy] = useState<'approve' | 'reject' | 'generate' | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [done, setDone] = useState<'approved' | 'rejected' | null>(
    row.status === 'published' || row.status === 'approved'
      ? 'approved'
      : row.status === 'rejected'
      ? 'rejected'
      : null,
  );

  const { mention } = row;
  const style = LABEL_STYLE[mention.sentimentLabel];
  const isCrisis = mention.sentimentLabel === 'crisis';

  const handleApprove = async () => {
    setBusy('approve');
    try {
      await onApprove(row.id, script, platform || null);
      setDone('approved');
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    setBusy('reject');
    try {
      await onReject(row.id);
      setDone('rejected');
    } finally {
      setBusy(null);
    }
  };

  const handleGenerate = async () => {
    setBusy('generate');
    setGenError(null);
    try {
      const res = await fetch(`/api/shield/actions/${row.id}/generate`, { method: 'POST' });
      const data = await res.json().catch(() => ({})) as { script?: string; error?: string };
      if (!res.ok) { setGenError(data.error ?? 'Failed'); return; }
      setScript(data.script ?? '');
    } catch {
      setGenError('Network error');
    } finally {
      setBusy(null);
    }
  };

  if (done === 'rejected') {
    return (
      <article
        style={{
          background: 'var(--bg-elev)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r)',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          opacity: 0.45,
        }}
      >
        <Icon name="x" size={13} />
        <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>Dismissed — {mention.title.slice(0, 80)}</span>
      </article>
    );
  }

  if (done === 'approved') {
    return (
      <article
        style={{
          background: 'oklch(0.96 0.04 145)',
          border: '1px solid oklch(0.88 0.08 145)',
          borderRadius: 'var(--r)',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Icon name="check" size={13} />
        <span style={{ fontSize: 13, color: 'oklch(0.38 0.12 145)' }}>
          {row.status === 'published' ? 'Response published' : 'Response approved'} — {mention.title.slice(0, 80)}
        </span>
        {mention.url && (
          <a href={mention.url} target="_blank" rel="noopener noreferrer"
            style={{ marginLeft: 'auto', fontSize: 11, color: 'oklch(0.38 0.12 145)', opacity: 0.7 }}
          >
            <Icon name="arrow_up_right" size={11} />
          </a>
        )}
      </article>
    );
  }

  return (
    <article
      style={{
        background: 'var(--bg-elev)',
        border: `1px solid ${isCrisis ? 'oklch(0.85 0.12 25)' : 'var(--line)'}`,
        borderRadius: 'var(--r)',
        overflow: 'hidden',
        boxShadow: isCrisis
          ? '0 0 0 3px oklch(0.95 0.07 25), var(--shadow-1)'
          : 'var(--shadow-1)',
      }}
    >
      {/* Header */}
      <div style={{ padding: '14px 16px 12px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {/* Sentiment chip + source */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, paddingTop: 2 }}>
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '2px 7px',
              borderRadius: 100,
              background: style.bg,
              color: style.color,
              fontWeight: 700,
            }}
          >
            {style.label}
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              padding: '2px 7px',
              borderRadius: 100,
              background: 'var(--bg-sunk)',
              color: 'var(--ink-3)',
              border: '1px solid var(--line)',
            }}
          >
            {SOURCE_LABEL[mention.source] ?? mention.source}
          </span>
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <a
            href={mention.url || '#'}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'block',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--ink)',
              textDecoration: 'none',
              lineHeight: 1.35,
              letterSpacing: '-0.01em',
              marginBottom: 4,
            }}
          >
            {mention.title}
          </a>
          {mention.body && (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
              {mention.body.slice(0, 200)}{mention.body.length > 200 ? '…' : ''}
            </p>
          )}
          <div
            className="mono"
            style={{
              marginTop: 6,
              fontSize: 10.5,
              color: 'var(--ink-4)',
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span>{mention.author}</span>
            <span>·</span>
            <span>{relTime(mention.fetchedAt)}</span>
            {mention.engagement > 0 && (
              <>
                <span>·</span>
                <span>{mention.engagement} engagement</span>
              </>
            )}
            {mention.theme && (
              <>
                <span>·</span>
                <span>{mention.theme}</span>
              </>
            )}
          </div>
          {(mention.crisisWords?.length || mention.negWords?.length) ? (
            <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {[...(mention.crisisWords ?? []), ...(mention.negWords ?? [])].slice(0, 5).map(w => (
                <span
                  key={w}
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: isCrisis ? 'oklch(0.94 0.08 25)' : 'oklch(0.95 0.05 50)',
                    color: isCrisis ? 'oklch(0.38 0.18 25)' : 'oklch(0.42 0.14 50)',
                    fontWeight: 600,
                  }}
                >
                  {w}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* Severity + expand toggle */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: isCrisis ? 'oklch(0.38 0.18 25)' : 'var(--ink-3)',
            }}
          >
            {mention.severity}/10
          </div>
          <button
            onClick={() => setExpanded(e => !e)}
            className="btn ghost sm"
            style={{ padding: '4px 8px', fontSize: 11, gap: 4 }}
          >
            {expanded ? 'Hide' : 'Respond'}{' '}
            <Icon name={expanded ? 'chevron_down' : 'chevron_right'} size={11} />
          </button>
        </div>
      </div>

      {/* Script editor + action buttons */}
      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--line)',
            padding: '14px 16px',
            background: 'var(--bg-sunk)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              className="mono"
              style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-4)' }}
            >
              Response {script ? '· edit before publishing' : '· write or generate with AI'}
            </span>
            <div style={{ flex: 1 }} />
            <button
              className="btn sm"
              onClick={handleGenerate}
              disabled={busy !== null}
              style={{ fontSize: 11, gap: 4 }}
            >
              <Icon name="sparkle" size={11} />
              {busy === 'generate' ? 'Generating…' : script ? 'Regenerate' : 'Generate with AI'}
            </button>
          </div>
          {genError && (
            <p style={{ margin: 0, fontSize: 12, color: 'oklch(0.42 0.18 25)' }}>{genError}</p>
          )}
          <textarea
            value={script}
            onChange={e => setScript(e.target.value)}
            rows={6}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--line-2)',
              background: 'var(--bg-elev)',
              color: 'var(--ink)',
              fontSize: 13,
              lineHeight: 1.6,
              resize: 'vertical',
              fontFamily: 'var(--sans)',
              boxSizing: 'border-box',
            }}
            placeholder="Write your response, or click 'Generate with AI' above…"
          />

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {connectedPlatforms.length > 0 && (
              <select
                value={platform}
                onChange={e => setPlatform(e.target.value)}
                style={{
                  padding: '7px 10px',
                  borderRadius: 'var(--r-sm)',
                  border: '1px solid var(--line-2)',
                  background: 'var(--bg-elev)',
                  color: 'var(--ink)',
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                <option value="">No platform (save only)</option>
                {connectedPlatforms.map(p => (
                  <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
            )}
            <div style={{ flex: 1 }} />
            <button
              className="btn sm"
              onClick={handleReject}
              disabled={busy !== null}
              style={{ color: 'var(--ink-3)' }}
            >
              {busy === 'reject' ? 'Dismissing…' : 'Dismiss'}
            </button>
            <button
              className="btn primary sm"
              onClick={handleApprove}
              disabled={busy !== null || !script.trim()}
            >
              <Icon name="check" size={12} />
              {busy === 'approve' ? 'Publishing…' : platform ? `Publish to ${platform}` : 'Approve'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
};
