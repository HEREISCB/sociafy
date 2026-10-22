'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Icon } from '../icons';
import { Button, useToast } from '../ui';
import { friendlyApiError } from '../../lib/ui/fetcher';
import { PLATFORMS } from '../../lib/ui/platforms';
import { supportsKind } from '../../lib/platforms/capabilities';
import type { MentionSource, SentimentLabel } from '../../lib/db/schema';

export type ShieldActionRow = {
  id: string;
  status: string;
  script: string;
  targetPlatform: string | null;
  error?: string | null;
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
  crisis: { badge: 'err', label: 'Crisis' },
  negative: { badge: 'warn', label: 'Negative' },
  neutral: { badge: '', label: 'Neutral' },
  positive: { badge: 'ok', label: 'Positive' },
};

const SOURCE_LABEL: Record<string, string> = {
  google_news: 'News',
  hackernews: 'HN',
  wikipedia: 'Wikipedia',
  reddit: 'Reddit',
  x: 'X',
  linkedin: 'LinkedIn',
  own_post: 'Own post',
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

/** The one-line "what happened" left behind once a mention is handled. */
export function MentionReceipt({ row, dismissed }: { row: ShieldActionRow; dismissed?: boolean }) {
  const name = PLATFORMS.find((p) => p.id === row.targetPlatform)?.name ?? row.targetPlatform;
  const ok = !dismissed && row.status !== 'rejected';
  const what = dismissed || row.status === 'rejected' ? 'Dismissed' : row.status === 'published' ? `Posted to ${name}` : 'Marked handled';
  return (
    <article className={`mention-receipt${ok ? ' is-ok' : ''}`}>
      <Icon name={ok ? 'check' : 'x'} size={12} />
      <span>{what} · {row.mention.title.slice(0, 80)}</span>
      {row.mention.url && (
        <a href={row.mention.url} target="_blank" rel="noopener noreferrer" aria-label="Open mention">
          <Icon name="arrow_up_right" size={12} />
        </a>
      )}
    </article>
  );
}

interface Props {
  row: ShieldActionRow;
  onApprove: (id: string, script: string, targetPlatform: string | null) => Promise<void>;
  onDismiss: (row: ShieldActionRow) => void;
  connectedPlatforms: string[];
}

export const MentionCard: React.FC<Props> = ({ row, onApprove, onDismiss, connectedPlatforms }) => {
  const toast = useToast();
  const textTargets = PLATFORMS.filter((p) => supportsKind(p.id, 'text') && connectedPlatforms.includes(p.id));
  const [expanded, setExpanded] = useState(row.mention.sentimentLabel === 'crisis' || row.status === 'failed');
  const [script, setScript] = useState(row.script);
  const [platform, setPlatform] = useState<string>(textTargets.some((p) => p.id === row.targetPlatform) ? row.targetPlatform! : '');
  const [busy, setBusy] = useState<'approve' | 'generate' | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(row.status === 'failed' ? row.error ?? 'The last attempt failed. Try again.' : null);
  // usedAI:false means the draft came from the canned template, not the model.
  const [isTemplate, setIsTemplate] = useState(false);
  const [drafted, setDrafted] = useState(0);
  const [handled, setHandled] = useState<ShieldActionRow | null>(null);

  const { mention } = row;
  const label = LABEL[mention.sentimentLabel];
  const isCrisis = mention.sentimentLabel === 'crisis';
  const target = PLATFORMS.find((p) => p.id === platform);

  // onApprove throws when the request fails, so the card never flips to "posted" off an unchecked response.
  const handleApprove = async () => {
    setBusy('approve');
    setActionError(null);
    try {
      await onApprove(row.id, script, platform || null);
      setHandled({ ...row, status: platform ? 'published' : 'approved', targetPlatform: platform || null });
      toast(platform ? `Posted to ${target?.name}` : 'Marked handled');
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
      if (!res.ok) { setGenError(data.error ?? 'Couldn’t draft a reply. Try again.'); return; }
      const prev = script;
      setScript(data.script ?? '');
      setIsTemplate(data.usedAI === false);
      setDrafted((d) => d + 1);
      if (prev.trim()) toast('Draft replaced', { undo: () => setScript(prev) });
    } catch {
      setGenError('Network error. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  };

  if (handled) return <MentionReceipt row={handled} />;

  return (
    <article className={`mention${isCrisis ? ' crisis' : ''}`}>
      <div className="mention-meta">
        <span className={`badge ${label.badge}`}>{label.label}</span>
        <span>{SOURCE_LABEL[mention.source] ?? mention.source} · {mention.author} · {relTime(mention.fetchedAt)}</span>
        <span className="mention-sev" title="Severity">{mention.severity}/10</span>
      </div>
      {mention.url ? (
        <a className="mention-title" href={mention.url} target="_blank" rel="noopener noreferrer">
          {mention.title} <Icon name="arrow_up_right" size={12} />
        </a>
      ) : (
        <span className="mention-title">{mention.title}</span>
      )}
      {mention.body && (
        <p className="mention-body">{mention.body.slice(0, 220)}{mention.body.length > 220 ? '…' : ''}</p>
      )}

      {!expanded ? (
        <div className="row mention-quick">
          <button type="button" className="btn sm" onClick={() => setExpanded(true)}>Respond</button>
          <button type="button" className="btn sm ghost" onClick={() => onDismiss(row)}>Dismiss</button>
        </div>
      ) : (
        <div className="mention-reply">
          <div className="row">
            <span className="set-label">Your reply</span>
            <span className="mention-spacer" />
            <Button size="sm" busy={busy === 'generate'} disabled={busy !== null} onClick={handleGenerate}>
              <Icon name="sparkle" size={12} /> {busy === 'generate' ? 'Drafting…' : script ? 'Redraft' : 'Draft with AI'}
            </Button>
          </div>
          {genError && <p className="set-error" role="alert">{genError}</p>}
          <textarea
            key={drafted}
            className={`input${drafted ? ' develop' : ''}`}
            value={script}
            onChange={e => setScript(e.target.value)}
            rows={5}
            aria-label="Reply"
            placeholder="Write a reply, or draft one with AI."
          />
          {isTemplate && <p className="set-hint">Template draft: AI was unavailable. Edit before posting.</p>}

          <div className="row mention-actions">
            <label className="mention-target">
              <span className="set-hint">Post to</span>
              <select className="input" value={platform} onChange={e => setPlatform(e.target.value)} aria-label="Post to">
                <option value="">Don’t post, just mark handled</option>
                {PLATFORMS.map((p) => {
                  const text = supportsKind(p.id, 'text');
                  const on = connectedPlatforms.includes(p.id);
                  return (
                    <option key={p.id} value={p.id} disabled={!text || !on}>
                      {p.name}{!text ? ' (can’t take text replies)' : !on ? ' (not connected)' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <span className="mention-spacer" />
            <button type="button" className="btn sm ghost" onClick={() => onDismiss(row)} disabled={busy !== null}>Dismiss</button>
            <Button
              size="sm"
              variant="primary"
              busy={busy === 'approve'}
              disabled={busy !== null || (!!platform && !script.trim())}
              reason="Write or draft a reply to post it"
              onClick={handleApprove}
            >
              {busy === 'approve' ? (platform ? 'Posting…' : 'Saving…') : platform ? `Post to ${target?.name}` : 'Mark handled'}
            </Button>
          </div>
          {platform
            ? <p className="set-hint">Goes out as a new {target?.name} post from your account.</p>
            : !textTargets.length && <p className="set-hint"><Link href="/settings/connections">Connect X, LinkedIn, Facebook or Reddit</Link> to post replies from here.</p>}
          {actionError && <p className="set-error" role="alert">{actionError}</p>}
        </div>
      )}
    </article>
  );
};
