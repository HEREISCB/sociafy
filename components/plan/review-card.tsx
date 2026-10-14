'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Pglyph } from '../icons';
import { apiPatch, apiPost, friendlyApiError } from '../../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { PlanView } from '../../lib/agent/plan';
import type { Platform } from '../../lib/db/schema';

export type ReviewItem = PlanView['review'][number];
type Skipped = { reason: string; reasons?: Record<string, string>; platforms?: Platform[] };

export const PLATFORM_NAME: Record<Platform, string> = {
  x: 'X', linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', reddit: 'Reddit',
};

export function skipMessage(s: Skipped): string {
  if (s.reason === 'too_long') return `Too long for ${(s.platforms ?? []).map((p) => PLATFORM_NAME[p]).join(', ')}.`;
  if (s.reason === 'not_a_draft') return 'Already scheduled.';
  if (s.reason === 'not_found') return 'This post is gone.';
  return Object.values(s.reasons ?? {})[0] ?? 'Could not schedule this post.';
}

/** ISO → the value a datetime-local input wants, in the viewer's time zone. */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** "Thu 16 Oct · 12:39 AM" */
export const fmtSlot = (iso: string) => format(new Date(iso), 'EEE d MMM · h:mm a');

type Props = {
  item: ReviewItem;
  limits: Record<Platform, number>;
  onChange: () => void;
  /** Read-only until opened; the parent keeps one card open at a time. */
  expanded: boolean;
  onToggle: () => void;
};

export function ReviewCard({ item, limits, onChange, expanded, onToggle }: Props) {
  const [body, setBody] = useState(item.body);
  const [busy, setBusy] = useState<'approve' | 'skip' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Server knows the per-platform copy; once the caption is edited here, the
  // edited body is what posts (lib/agent/publish.ts postText).
  const dirty = body !== item.body;
  const over = dirty ? item.targetPlatforms.filter((p) => body.length > limits[p]) : item.tooLong;
  const media = item.media[0];

  const run = async (kind: 'approve' | 'skip' | 'save', fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(friendlyApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const save = () => (dirty ? run('save', () => apiPatch(`/api/drafts/${item.id}`, { body })) : undefined);
  const setTime = (v: string) => {
    if (!v) return;
    const iso = new Date(v).toISOString();
    if (iso !== item.plannedAt) run('save', () => apiPatch(`/api/drafts/${item.id}`, { plannedAt: iso }));
  };
  const approve = () =>
    run('approve', async () => {
      if (dirty) await apiPatch(`/api/drafts/${item.id}`, { body });
      const r = await apiPost<{ skipped: Skipped[] }>('/api/plan/approve', { draftIds: [item.id] });
      if (r.skipped[0]) throw new Error(skipMessage(r.skipped[0]));
    });
  const skip = () => run('skip', () => apiPost('/api/plan/skip', { draftId: item.id }));

  // Title, else the caption's first line; the excerpt is whatever follows.
  const lines = body.trim().split('\n').filter(Boolean);
  const title = item.title?.trim() || lines[0] || 'Untitled post';
  const excerpt = (item.title?.trim() ? lines : lines.slice(1)).join(' ');

  return (
    <article className={`plan-card${expanded ? ' plan-card--open' : ''}`}>
      <div className="plan-card__thumb">
        {item.rendering ? (
          <span className="plan-card__placeholder">Rendering…</span>
        ) : !media ? (
          <span className="plan-card__placeholder">Text</span>
        ) : media.mimeType?.startsWith('video/') ? (
          <video src={`${media.url}#t=0.1`} preload="metadata" muted playsInline controls={expanded} aria-label="Post video" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.url} alt="" loading="lazy" />
        )}
      </div>

      <div className="plan-card__main">
        {expanded ? (
          <>
            <span className="plan-card__title">{title}</span>
            <label className="sr-only" htmlFor={`cap-${item.id}`}>Caption</label>
            <textarea
              id={`cap-${item.id}`}
              className="input plan-card__caption"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onBlur={save}
              rows={6}
              disabled={item.approved}
              autoFocus
            />
            <label className="plan-card__time">
              <span className="muted">Post time</span>
              <input
                key={item.plannedAt ?? 'unset'}
                type="datetime-local"
                className="input"
                defaultValue={item.plannedAt ? toLocalInput(item.plannedAt) : ''}
                onBlur={(e) => setTime(e.target.value)}
                disabled={!!busy}
              />
            </label>
          </>
        ) : (
          <button type="button" className="plan-card__summary" onClick={onToggle} aria-expanded={false}>
            <span className="plan-card__title">{title}</span>
            {excerpt && <span className="plan-card__excerpt">{excerpt}</span>}
          </button>
        )}

        <div className="plan-card__meta">
          <span className="row plan-card__glyphs" aria-label={item.targetPlatforms.map((p) => PLATFORM_NAME[p]).join(', ')}>
            {item.targetPlatforms.map((p) => (
              <Pglyph key={p} p={PLATFORM_TO_SHORT[p]} />
            ))}
          </span>
          {!expanded && <span className="tnum">{item.plannedAt ? fmtSlot(item.plannedAt) : 'No time set'}</span>}
          {item.overdue && <span className="badge badge--warn">Time passed, moves to next free slot</span>}
        </div>

        {over.length > 0 && (
          <p className="plan-card__warn" role="status">
            Too long for {over.map((p) => `${PLATFORM_NAME[p]} (${body.length}/${limits[p]})`).join(', ')}
          </p>
        )}
        {error && <p className="plan-card__warn" role="alert">{error}</p>}

        <div className="row plan-card__actions">
          {item.approved ? (
            <span className="muted">Approved. Posts when the video is ready.</span>
          ) : (
            <>
              <button className="btn sm" onClick={approve} disabled={!!busy || over.length > 0}>
                {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button className="btn sm ghost" onClick={skip} disabled={!!busy}>
                {busy === 'skip' ? 'Skipping…' : 'Skip'}
              </button>
              <button className="btn sm ghost" onClick={onToggle} aria-expanded={expanded}>
                {expanded ? 'Done' : 'Edit'}
              </button>
              {busy === 'save' && <span className="muted">Saving…</span>}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
