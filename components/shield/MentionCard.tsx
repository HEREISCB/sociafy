'use client';

import React, { useState } from 'react';
import { Icon } from '../icons';
import { friendlyApiError } from '../../lib/ui/fetcher';
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

const LABEL: Record<SentimentLabel, { badge: string; label: string }> = {
  crisis: { badge: 'badge--err', label: 'Crisis' },
  negative: { badge: 'badge--warn', label: 'Negative' },
  neutral: { badge: '', label: 'Neutral' },
  positive: { badge: 'badge--ok', label: 'Positive' },
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
  const [actionError, setActionError] = useState<string | null>(null);
  // Set when /generate reports usedAI:false — the draft came from the canned
  // template, not the model, and the user should know before publishing it.
  const [isTemplate, setIsTemplate] = useState(false);
  const [done, setDone] = useState<'approved' | 'rejected' | null>(
    row.status === 'published' || row.status === 'approved'
      ? 'approved'
      : row.status === 'rejected'
      ? 'rejected'
      : null,
  );

  const { mention } = row;
  const label = LABEL[mention.sentimentLabel];
  const isCrisis = mention.sentimentLabel === 'crisis';

  // onApprove/onReject throw when the request fails — never flip the card to
  // the green "published" state off an unchecked response.
  const handleApprove = async () => {
    setBusy('approve');
    setActionError(null);
    try {
      await onApprove(row.id, script, platform || null);
      setDone('approved');
    } catch (e) {
      setActionError(friendlyApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    setBusy('reject');
    setActionError(null);
    try {
      await onReject(row.id);
      setDone('rejected');
    } catch (e) {
      setActionError(friendlyApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleGenerate = async () => {
    setBusy('generate');
    setGenError(null);
    try {
      const res = await fetch(`/api/shield/actions/${row.id}/generate`, { method: 'POST' });
      const data = await res.json().catch(() => ({})) as { script?: string; error?: string; usedAI?: boolean };
      if (!res.ok) { setGenError(data.error ?? 'Failed'); return; }
      setScript(data.script ?? '');
      setIsTemplate(data.usedAI === false);
    } catch {
      setGenError('Network error');
    } finally {
      setBusy(null);
    }
  };

  if (done === 'rejected') {
    return (
      <article className="mention done">
        <Icon name="x" size={12} />
        <span>Dismissed · {mention.title.slice(0, 80)}</span>
      </article>
    );
  }

  if (done === 'approved') {
    return (
      <article className="mention done ok">
        <Icon name="check" size={12} />
        <span>
          {row.status === 'published' ? 'Reply published' : 'Reply approved'} · {mention.title.slice(0, 80)}
        </span>
        {mention.url && (
          <a href={mention.url} target="_blank" rel="noopener noreferrer" aria-label="Open mention">
            <Icon name="arrow_up_right" size={12} />
          </a>
        )}
      </article>
    );
  }

  return (
    <article className={`mention${isCrisis ? ' crisis' : ''}`}>
      <div className="mention-head">
        <div className="mention-main">
          <div className="row mention-tags">
            <span className={`badge ${label.badge}`}>{label.label}</span>
            <span className="set-hint">
              {SOURCE_LABEL[mention.source] ?? mention.source} · {mention.author} · {relTime(mention.fetchedAt)}
              {mention.engagement > 0 && <> · {mention.engagement} engagement</>}
              {' '}· severity {mention.severity}/10
            </span>
          </div>
          <a className="mention-title" href={mention.url || '#'} target="_blank" rel="noopener noreferrer">
            {mention.title}
          </a>
          {mention.body && (
            <p className="mention-body">
              {mention.body.slice(0, 200)}{mention.body.length > 200 ? '…' : ''}
            </p>
          )}
        </div>
        <button
          onClick={() => setExpanded(e => !e)}
          className="btn sm"
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'Respond'}
        </button>
      </div>

      {expanded && (
        <div className="mention-reply">
          <div className="row">
            <span className="set-label">Reply</span>
            {isTemplate && (
              <span
                className="badge"
                title="AI drafting was unavailable, so this came from a built-in template. Edit it before publishing."
              >
                template draft
              </span>
            )}
            <span className="mention-spacer" />
            <button className="btn sm ghost" onClick={handleGenerate} disabled={busy !== null}>
              <Icon name="sparkle" size={12} />
              {busy === 'generate' ? 'Generating…' : script ? 'Regenerate' : 'Draft with AI'}
            </button>
          </div>
          {genError && <p className="set-error">{genError}</p>}
          <textarea
            className="input"
            value={script}
            onChange={e => setScript(e.target.value)}
            rows={5}
            aria-label="Reply"
            placeholder="Write a reply, or draft one with AI."
          />

          <div className="row mention-actions">
            {connectedPlatforms.length > 0 && (
              <select
                className="input"
                value={platform}
                onChange={e => setPlatform(e.target.value)}
                aria-label="Publish to"
              >
                <option value="">No platform (save only)</option>
                {connectedPlatforms.map(p => (
                  <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
            )}
            <span className="mention-spacer" />
            <button className="btn sm ghost" onClick={handleReject} disabled={busy !== null}>
              {busy === 'reject' ? 'Dismissing…' : 'Dismiss'}
            </button>
            <button
              className="btn primary sm"
              onClick={handleApprove}
              disabled={busy !== null || !script.trim()}
            >
              {busy === 'approve' ? 'Publishing…' : platform ? `Publish to ${platform}` : 'Approve'}
            </button>
          </div>

          {actionError && <p className="set-error" role="alert">{actionError}</p>}
        </div>
      )}
    </article>
  );
};
