'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { apiPost, friendlyApiError } from '../../lib/ui/fetcher';
import { PLATFORM_LABELS } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';
import { Glyphs } from '../calendar/glyphs';
import { firstLine, type CalItem } from '../calendar/model';
import { Grip, Thumb, useDragProps } from '../calendar/views';

export type Skipped = { reason: string; reasons?: Record<string, string>; platforms?: Platform[] };
export type Approved = { scheduledAt: string | null; rendering?: true };

export function skipMessage(s: Skipped): string {
  if (s.reason === 'too_long') return `Too long for ${(s.platforms ?? []).map((p) => PLATFORM_LABELS[p] ?? p).join(', ')}.`;
  if (s.reason === 'not_a_draft') return 'Already scheduled.';
  if (s.reason === 'not_found') return 'This post is gone.';
  return Object.values(s.reasons ?? {})[0] ?? 'Could not schedule this post.';
}

/** "Thu 16 Oct · 12:39 AM" */
export const fmtSlot = (iso: string) => format(new Date(iso), 'EEE d MMM · h:mm a');

export function approvedMessage(a?: Approved): string {
  if (a?.rendering) return 'Approved. It posts when the video is ready.';
  return a?.scheduledAt ? `Approved for ${fmtSlot(a.scheduledAt)}.` : 'Approved.';
}

/** A draft with no time, in the "Needs a time" tray. Approve takes the next free slot. */
export function TrayCard({ item, onOpen, onDone }: { item: Extract<CalItem, { kind: 'draft' }>; onOpen: () => void; onDone: (msg: string) => void }) {
  const d = item.draft;
  const [busy, setBusy] = useState<'approve' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useDragProps(item);

  const run = async (kind: 'approve' | 'skip', fn: () => Promise<string>) => {
    setBusy(kind);
    setError(null);
    try {
      onDone(await fn());
    } catch (e) {
      setError(friendlyApiError(e));
    } finally {
      setBusy(null);
    }
  };
  const approve = () =>
    run('approve', async () => {
      const r = await apiPost<{ approved: Approved[]; skipped: Skipped[] }>('/api/plan/approve', { draftIds: [d.id] });
      if (r.skipped[0]) throw new Error(skipMessage(r.skipped[0]));
      return approvedMessage(r.approved[0]);
    });
  const skip = () => run('skip', async () => { await apiPost('/api/plan/skip', { draftId: d.id }); return 'Skipped.'; });

  return (
    <article className={`tray-card${drag.dragged ? ' is-dragged' : ''}`} {...drag.props}>
      {'draggable' in drag.props && <span className="tray-card__grip" title="Drag onto a day"><Grip /></span>}
      <button type="button" className="tray-card__open" onClick={onOpen}>
        <Thumb item={item} />
        <span className="tray-card__main">
          <span className="hc__title">{d.title?.trim() || firstLine(d.body)}</span>
          <Glyphs platforms={d.targetPlatforms ?? []} />
        </span>
      </button>
      {d.tooLong.length > 0 && <p className="tray-card__warn">Too long for {d.tooLong.map((p) => PLATFORM_LABELS[p] ?? p).join(', ')}. Open to edit.</p>}
      {error && <p className="tray-card__warn" role="alert">{error}</p>}
      {d.approved ? (
        <p className="tray-card__note">Approved. Posts when the video is ready.</p>
      ) : (
        <div className="row tray-card__actions">
          <button type="button" className="btn sm primary" onClick={approve} disabled={!!busy || d.tooLong.length > 0}>{busy === 'approve' ? 'Approving…' : 'Approve'}</button>
          <button type="button" className="btn sm ghost tray-card__quiet" onClick={skip} disabled={!!busy}>{busy === 'skip' ? 'Skipping…' : 'Skip'}</button>
          <button type="button" className="btn sm ghost tray-card__quiet" onClick={onOpen} disabled={!!busy}>Pick time</button>
        </div>
      )}
    </article>
  );
}
