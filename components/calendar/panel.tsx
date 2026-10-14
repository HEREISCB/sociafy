'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { addMinutes, format, startOfHour, addHours } from 'date-fns';
import { Icon } from '../icons';
import { apiDelete, apiPatch, friendlyApiError } from '../../lib/ui/fetcher';
import { PLATFORM_LABELS } from '../../lib/ui/platforms';
import { Glyphs } from './glyphs';
import { restorable, type PostGroup } from './model';

const toInput = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");

/** Side panel (bottom sheet on phones) for one post. Shows exactly the actions
 *  its status allows; every action reports failure inline. */
export function PostPanel({ group, onClose, onDone, refresh }: {
  group: PostGroup;
  onClose: () => void;
  /** Called after a successful action with a short confirmation; closes the panel. */
  onDone: (msg: string) => void;
  /** Revalidate the schedule without closing (a partial failure may have moved some rows). */
  refresh: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);

  // A past time can't be reused: seed the next whole hour instead.
  const [when, setWhen] = useState(() =>
    toInput(group.at.getTime() > Date.now() ? group.at : startOfHour(addHours(new Date(), 1))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(group.accountGone);

  const run = async (action: (id: string) => Promise<unknown>, msg: string) => {
    setBusy(true);
    setError(null);
    const results = await Promise.allSettled(group.rows.map((r) => action(r.id)));
    setBusy(false);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      if (String(failed.reason?.message ?? '').includes('account_disconnected')) setDisconnected(true);
      setError(friendlyApiError(failed.reason));
      // Some platforms may have gone through; let the list catch up.
      refresh();
      return;
    }
    onDone(msg);
  };

  const moveTo = (d: Date, msg: string) => run((id) => apiPatch(`/api/schedule/${id}`, { scheduledAt: d.toISOString() }), msg);
  const cancel = () => run((id) => apiDelete(`/api/schedule/${id}`), 'Canceled. Restore it from the list anytime.');
  const picked = new Date(when);
  const pickedValid = !Number.isNaN(picked.getTime());
  const unchanged = when === toInput(group.at);
  const editable = group.status === 'pending' || group.status === 'failed' || restorable(group);

  return (
    <dialog
      ref={ref}
      className="cal-panel"
      aria-labelledby="cal-panel-title"
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) ref.current?.close(); }}
    >
      <div className="cal-panel__inner stack">
        <header className="row">
          <Glyphs platforms={group.platforms} />
          <h2 id="cal-panel-title" className="cal-panel__title">
            {format(group.at, 'EEE, MMM d · p')}
          </h2>
          <button type="button" className="icon-btn" onClick={() => ref.current?.close()} aria-label="Close" disabled={busy}>
            <Icon name="x" size={14} />
          </button>
        </header>

        <p className="cal-panel__meta">
          {statusLabel(group)} · {group.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(', ')}
        </p>

        <p className="cal-panel__text">{group.text}</p>

        {group.status === 'failed' && (
          <p className="cal-panel__error">{group.error || 'It failed without a recorded reason.'}</p>
        )}

        {disconnected && (
          <p className="cal-panel__note">
            The account for this post is disconnected.{' '}
            <Link href="/settings/connections">Reconnect</Link>
          </p>
        )}

        {editable && (
          <label className="stack cal-panel__field">
            <span>{group.status === 'pending' ? 'Time' : 'New time'}</span>
            <input
              className="input"
              type="datetime-local"
              value={when}
              min={toInput(new Date())}
              onChange={(e) => setWhen(e.target.value)}
              disabled={busy}
            />
          </label>
        )}

        {error && <p className="cal-panel__error" role="alert">{error}</p>}

        <div className="row cal-panel__actions">
          {group.status === 'pending' && (
            <>
              <button type="button" className="btn primary" disabled={busy || unchanged || !pickedValid} onClick={() => moveTo(picked, 'Rescheduled.')}>
                Reschedule
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={cancel}>Cancel post</button>
            </>
          )}
          {group.status === 'failed' && (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => moveTo(addMinutes(new Date(), 5), 'Queued to retry in 5 minutes.')}>
                Retry
              </button>
              <button type="button" className="btn" disabled={busy || !pickedValid} onClick={() => moveTo(picked, 'Rescheduled.')}>
                Retry at this time
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={cancel}>Cancel post</button>
            </>
          )}
          {restorable(group) && (
            <button type="button" className="btn primary" disabled={busy || !pickedValid} onClick={() => moveTo(picked, 'Restored.')}>
              Restore
            </button>
          )}
          {group.status === 'published' && group.url && (
            <a className="btn" href={group.url} target="_blank" rel="noreferrer">
              View post <Icon name="arrow_up_right" size={12} />
            </a>
          )}
        </div>
      </div>
    </dialog>
  );
}

export const STATUS_LABEL: Record<PostGroup['status'], string> = {
  pending: 'Scheduled',
  publishing: 'Publishing now',
  published: 'Posted',
  failed: 'Failed',
  canceled: 'Canceled',
};

/** Canceled rows the user didn't cancel say why instead. */
const CANCEL_REASON: Record<string, string> = {
  superseded_by_post_now: 'Posted via Post now',
  account_disconnected: 'Account disconnected',
};

export const statusLabel = (g: PostGroup) =>
  (g.status === 'canceled' && g.error && CANCEL_REASON[g.error]) || STATUS_LABEL[g.status];
