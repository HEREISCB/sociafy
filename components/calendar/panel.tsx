'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { addMinutes, format, startOfHour, addHours } from 'date-fns';
import { Icon } from '../icons';
import { apiDelete, apiPatch, apiPost, friendlyApiError } from '../../lib/ui/fetcher';
import { PLATFORM_LABELS } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';
import { Glyphs } from './glyphs';
import { restorable, statusLabel, type CalItem, type PostGroup, type ReviewItem } from './model';
import { Thumb } from './views';
import { approvedMessage, skipMessage, type Approved, type Skipped } from '../plan/review-card';

const toInput = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");

type Props = {
  item: CalItem;
  limits: Record<Platform, number>;
  onClose: () => void;
  /** Called after a successful action with a short confirmation; closes the panel. */
  onDone: (msg: string) => void;
  /** Revalidate without closing (a save, or a partial failure that moved some rows). */
  refresh: () => void;
};

/** Side panel (bottom sheet on phones) for one draft or post. Shows exactly the
 *  actions its status allows; every action reports failure inline. */
export function PostPanel({ item, limits, onClose, onDone, refresh }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const [busy, setBusy] = useState(false);
  const close = () => { if (!busy) ref.current?.close(); };
  const label = item.kind === 'draft' ? 'Draft' : statusLabel(item.group);

  return (
    <dialog
      ref={ref}
      className="cal-panel"
      aria-labelledby="cal-panel-title"
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="cal-panel__inner stack">
        <header className="row">
          <h2 id="cal-panel-title" className="cal-panel__title">
            {item.at ? format(item.at, 'EEE d MMM · h:mm a') : 'No time set'}
          </h2>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close" disabled={busy}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <p className="cal-panel__meta row">
          <span className={`badge${item.kind === 'draft' ? ' badge--accent' : item.group.status === 'failed' || item.group.accountGone ? ' badge--err' : item.group.status === 'published' ? ' badge--ok' : ''}`}>{item.kind === 'draft' && !item.draft.approved ? 'Needs review' : label}</span>
        </p>
        <div className="cal-panel__media"><Thumb item={item} controls /></div>
        {item.kind === 'draft'
          ? <DraftBody d={item.draft} limits={limits} busy={busy} setBusy={setBusy} onDone={onDone} refresh={refresh} />
          : <PostBody group={item.group} busy={busy} setBusy={setBusy} onDone={onDone} refresh={refresh} />}
      </div>
    </dialog>
  );
}

type BodyProps = { busy: boolean; setBusy: (b: boolean) => void; onDone: (msg: string) => void; refresh: () => void };

function DraftBody({ d, limits, busy, setBusy, onDone, refresh }: BodyProps & { d: ReviewItem; limits: Record<Platform, number> }) {
  const [body, setBody] = useState(d.body);
  const [saved, setSaved] = useState(d.body);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const platforms = d.targetPlatforms ?? [];
  // Server knows the per-platform copy; once the caption is edited here, the
  // edited body is what posts (lib/agent/publish.ts postText).
  const dirty = body !== d.body;
  const over = dirty ? platforms.filter((p) => body.length > limits[p]) : d.tooLong;

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    try {
      const msg = await fn();
      if (msg) onDone(msg);
    } catch (e) {
      setError(friendlyApiError(e));
    } finally {
      setBusy(false);
    }
  };
  const quiet = async (patch: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/api/drafts/${d.id}`, patch);
      refresh();
    } catch (e) {
      setError(friendlyApiError(e));
    } finally {
      setSaving(false);
    }
  };
  const saveBody = () => { if (body !== saved) { setSaved(body); quiet({ body }); } };
  const setTime = (v: string) => {
    if (!v) return;
    const iso = new Date(v).toISOString();
    if (iso !== d.plannedAt) quiet({ plannedAt: iso });
  };
  const approve = () =>
    run(async () => {
      if (dirty) await apiPatch(`/api/drafts/${d.id}`, { body });
      const r = await apiPost<{ approved: Approved[]; skipped: Skipped[] }>('/api/plan/approve', { draftIds: [d.id] });
      if (r.skipped[0]) throw new Error(skipMessage(r.skipped[0]));
      return approvedMessage(r.approved[0]);
    });
  const skip = () => run(async () => { await apiPost('/api/plan/skip', { draftId: d.id }); return 'Skipped. Its slot is free again.'; });

  return (
    <>
      <label className="stack cal-panel__field">
        <span>Caption</span>
        <textarea
          className="input cal-panel__caption"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={saveBody}
          rows={8}
          disabled={d.approved || busy}
        />
      </label>
      <PlatformLine platforms={platforms} />
      {over.length > 0 && (
        <p className="cal-panel__error" role="status">
          Too long for {over.map((p) => `${PLATFORM_LABELS[p] ?? p} (${body.length}/${limits[p]})`).join(', ')}
        </p>
      )}
      <label className="stack cal-panel__field">
        <span>Post time</span>
        <input
          key={d.plannedAt ?? 'unset'}
          type="datetime-local"
          className="input"
          defaultValue={d.plannedAt ? toInput(new Date(d.plannedAt)) : ''}
          onBlur={(e) => setTime(e.target.value)}
          disabled={busy || d.approved}
          autoFocus={!d.plannedAt}
        />
      </label>
      {!d.plannedAt && <p className="cal-panel__note">No time yet. Approve to take the next free slot, or pick one.</p>}
      {d.overdue && <p className="cal-panel__note">This time passed. Approving moves it to the next free slot.</p>}
      {d.rendering && !d.approved && <p className="cal-panel__note">The video is still rendering. Approve now and it posts when the clip is ready.</p>}
      {error && <p className="cal-panel__error" role="alert">{error}</p>}
      <div className="row cal-panel__actions">
        {d.approved ? (
          <span className="cal-panel__note">Approved. Posts when the video is ready.</span>
        ) : (
          <>
            <button type="button" className="btn primary" onClick={approve} disabled={busy || over.length > 0}>Approve</button>
            <button type="button" className="btn ghost" onClick={skip} disabled={busy}>Skip</button>
            {saving && <span className="cal-panel__note" role="status">Saving…</span>}
          </>
        )}
      </div>
    </>
  );
}

function PlatformLine({ platforms }: { platforms: Platform[] }) {
  return (
    <p className="cal-panel__meta row">
      <Glyphs platforms={platforms} />
      <span>{platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(', ') || 'No platforms'}</span>
    </p>
  );
}

function PostBody({ group, busy, setBusy, onDone, refresh }: BodyProps & { group: PostGroup }) {
  // A past time can't be reused: seed the next whole hour instead.
  const [when, setWhen] = useState(() =>
    toInput(group.at.getTime() > Date.now() ? group.at : startOfHour(addHours(new Date(), 1))));
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
      // Some platforms may have gone through; let the calendar catch up.
      refresh();
      return;
    }
    onDone(msg);
  };

  const moveTo = (d: Date, msg: string) => run((id) => apiPatch(`/api/schedule/${id}`, { scheduledAt: d.toISOString() }), msg);
  const cancel = () => run((id) => apiDelete(`/api/schedule/${id}`), 'Canceled. Open it to restore.');
  const picked = new Date(when);
  const pickedValid = !Number.isNaN(picked.getTime());
  const unchanged = when === toInput(group.at);
  const editable = group.status === 'pending' || group.status === 'failed' || restorable(group);

  return (
    <>
      <p className="cal-panel__text">{group.text}</p>
      <PlatformLine platforms={group.platforms} />
      {group.status === 'failed' && <p className="cal-panel__error">{group.error || 'It failed without a recorded reason.'}</p>}
      {disconnected && (
        <p className="cal-panel__note">The account for this post is disconnected. <Link href="/settings/connections">Reconnect</Link></p>
      )}
      {editable && (
        <label className="stack cal-panel__field">
          <span>{group.status === 'pending' ? 'Time' : 'New time'}</span>
          <input className="input" type="datetime-local" value={when} min={toInput(new Date())} onChange={(e) => setWhen(e.target.value)} disabled={busy} />
        </label>
      )}
      {error && <p className="cal-panel__error" role="alert">{error}</p>}
      <div className="row cal-panel__actions">
        {group.status === 'pending' && (
          <>
            <button type="button" className="btn primary" disabled={busy || unchanged || !pickedValid} onClick={() => moveTo(picked, 'Rescheduled.')}>Reschedule</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={cancel}>Cancel post</button>
          </>
        )}
        {group.status === 'failed' && (
          <>
            {disconnected ? (
              <Link className="btn primary" href="/settings/connections">Reconnect</Link>
            ) : (
              <button type="button" className="btn primary" disabled={busy} onClick={() => moveTo(addMinutes(new Date(), 5), 'Queued to retry in 5 minutes.')}>Retry</button>
            )}
            <button type="button" className="btn" disabled={busy || !pickedValid} onClick={() => moveTo(picked, 'Rescheduled.')}>Retry at this time</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={cancel}>Cancel post</button>
          </>
        )}
        {restorable(group) && (
          <button type="button" className="btn primary" disabled={busy || !pickedValid} onClick={() => moveTo(picked, 'Restored.')}>Restore</button>
        )}
        {group.status === 'published' && group.url && (
          <a className="btn" href={group.url} target="_blank" rel="noreferrer">View post <Icon name="arrow_up_right" size={12} /></a>
        )}
      </div>
    </>
  );
}
