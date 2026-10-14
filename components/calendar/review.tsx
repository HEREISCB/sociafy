'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addDays, format } from 'date-fns';
import { Icon } from '../icons';
import { PLATFORM_LABELS } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';
import { Glyphs } from './glyphs';
import {
  KIND_LABEL, dayKey, isVideo, itemMedia, itemPlatforms, itemText, kindOf, movable, restorable, statusLabel, toneOf, type CalItem,
} from './model';

export type PostAction = 'cancel' | 'retry' | 'restore';

type Props = {
  item: CalItem;
  index: number;
  total: number;
  /** Which way the user browsed: the body slides in from that side. */
  dir: number;
  /** Epoch ms, ticking; picks closer than 5 minutes to it are disabled. */
  now: number;
  today: Date;
  limits: Record<Platform, number>;
  onStep: (n: 1 | -1) => void;
  onApprove: (body: string) => void;
  onSkip: () => void;
  onSaveBody: (body: string) => void;
  onReschedule: (at: Date) => void;
  onPost: (a: PostAction) => void;
};

const typing = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, select, [contenteditable]');

/** One post up for review: media on the left, copy and actions on the right. Remount per post (key). */
export function ReviewPanel({ item, index, total, dir, now, today, limits, onStep, onApprove, onSkip, onSaveBody, onReschedule, onPost }: Props) {
  const draft = item.kind === 'draft' ? item.draft : null;
  const [body, setBody] = useState(itemText(item));
  const cap = useRef<HTMLTextAreaElement>(null);
  const platforms = itemPlatforms(item);
  const tone = toneOf(item);
  const canReview = tone === 'review';
  // Edited here, the body is what posts on every platform (lib/agent/publish.ts postText).
  const over = !draft ? [] : body !== draft.body ? platforms.filter((p) => body.length > limits[p]) : draft.tooLong;

  useLayoutEffect(() => {
    const t = cap.current;
    if (t) { t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }
  }, [body]);

  // A approve · S skip · ←/→ browse. Not while typing, with a modifier, or with a popover/dialog open.
  const canApprove = canReview && !over.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('.when-pop, dialog[open]')) return;
      const key = e.key.toLowerCase();
      if (key === 'a' && canApprove) { e.preventDefault(); onApprove(body); }
      else if (key === 's' && canReview) { e.preventDefault(); onSkip(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); onStep(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onStep(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canApprove, canReview, body, onApprove, onSkip, onStep]);

  const main = platforms[0];
  return (
    <section className="hr" aria-label="Review post">
      <div className="hr__stage">
        <Media item={item} body={body} />
        <span className="hr__stage-l">
          {main && <Glyphs platforms={[main]} />}
          {main ? PLATFORM_LABELS[main] ?? main : 'No platform'} · {KIND_LABEL[kindOf(item)]}
        </span>
      </div>

      <div className={`hr__body${dir < 0 ? ' is-prev' : dir > 0 ? ' is-next' : ''}`}>
        <div className="hr__meta">
          <span className="hr__kind">{KIND_LABEL[kindOf(item)]}</span>
          {draft?.title?.trim() && <><span className="hr__sep" /><span className="hr__topic">{draft.title.trim()}</span></>}
          <span className={`hr__st hr__st--${tone}`}>{statusLabel(item)}</span>
          <span className="hr__nav">
            <span className="hr__pos tnum">{index + 1} / {total}</span>
            <button type="button" className="icon-btn" aria-label="Previous post" onClick={() => onStep(-1)}><Icon name="chevron_left" size={14} /></button>
            <button type="button" className="icon-btn" aria-label="Next post" onClick={() => onStep(1)}><Icon name="chevron_right" size={14} /></button>
          </span>
        </div>

        {draft && !draft.approved ? (
          <textarea
            ref={cap}
            className="hr__cap"
            aria-label="Caption"
            rows={1}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => { if (body !== draft.body) onSaveBody(body); }}
          />
        ) : (
          <p className="hr__cap is-static">{body}</p>
        )}
        {over.length > 0 && (
          <p className="hr__warn" role="status">
            Too long for {over.map((p) => `${PLATFORM_LABELS[p] ?? p} (${body.length}/${limits[p]})`).join(', ')}
          </p>
        )}

        <div className="hr__row">
          <span className="hr__lbl">Goes to</span>
          <span className="hr__plats">
            {platforms.length ? platforms.map((p) => (
              <span key={p} className="hr__plat"><Glyphs platforms={[p]} />{PLATFORM_LABELS[p] ?? p}</span>
            )) : <span className="hr__note">No platforms</span>}
          </span>
        </div>

        <div className="hr__row">
          <span className="hr__lbl">Posts</span>
          <When item={item} now={now} today={today} onPick={onReschedule} />
        </div>

        {draft?.rationale && (
          <p className="hr__why"><b>Why this</b>{draft.rationale}</p>
        )}
        {draft?.overdue && !draft.approved && <p className="hr__note">This time passed. Approving moves it to the next free slot.</p>}
        {draft?.rendering && <p className="hr__note">{draft.approved ? 'Approved. It posts when the video is ready.' : 'The video is still rendering. Approve now and it posts when the clip is ready.'}</p>}
        {item.kind === 'post' && item.group.status === 'failed' && <p className="hr__warn">{item.group.error || 'It failed without a recorded reason.'}</p>}
      </div>

      <div className="hr__acts">
        {canReview ? (
          <>
            <button type="button" className="btn primary hr__big" onClick={() => onApprove(body)} disabled={!canApprove}>Approve <kbd>A</kbd></button>
            <button type="button" className="btn ghost hr__big" onClick={onSkip}>Skip <kbd>S</kbd></button>
          </>
        ) : (
          <>
            <span className={`hr__done hr__done--${tone}`}>
              {['waiting', 'pending', 'publishing', 'published'].includes(tone) && <Tick />}
              {statusLabel(item)}
            </span>
            {item.kind === 'post' && tone === 'pending' && <button type="button" className="btn ghost hr__big" onClick={() => onPost('cancel')}>Cancel post</button>}
            {item.kind === 'post' && item.group.status === 'failed' && !item.group.accountGone && <button type="button" className="btn hr__big" onClick={() => onPost('retry')}>Retry</button>}
            {item.kind === 'post' && item.group.accountGone && <a className="btn hr__big" href="/settings/connections">Reconnect</a>}
            {item.kind === 'post' && restorable(item.group) && <button type="button" className="btn hr__big" onClick={() => onPost('restore')}>Restore</button>}
            {item.kind === 'post' && item.group.url && <a className="btn ghost hr__big" href={item.group.url} target="_blank" rel="noreferrer">View post <Icon name="arrow_up_right" size={12} /></a>}
          </>
        )}
        <span className="hr__keys">
          <span><kbd>←</kbd><kbd>→</kbd> browse</span>
          {canReview && <><span><kbd>A</kbd> approve</span><span><kbd>S</kbd> skip</span></>}
        </span>
      </div>
    </section>
  );
}

export function Tick() {
  return (
    <svg className="tick" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path pathLength={1} d="M2.5 6.4l2.4 2.3 4.6-5" />
    </svg>
  );
}

/** The real media, sized by the stage's height; a text post renders as its copy. */
function Media({ item, body }: { item: CalItem; body: string }) {
  const m = itemMedia(item);
  if (m && isVideo(m)) return <video key={m.url} className="hr__media" src={m.url} controls muted playsInline preload="metadata" />;
  // eslint-disable-next-line @next/next/no-img-element
  if (m) return <img key={m.url} className="hr__media" src={m.url} alt="" />;
  if (kindOf(item) === 'video') return <div className="hr__media hr__media--ph">Rendering video…</div>;
  return <div className="hr__media hr__textpost"><p>{body}</p></div>;
}

/** Hand-picked slots; the post's own time is added when it isn't one of them. */
const TIMES = ['08:00', '09:00', '10:00', '12:00', '13:00', '15:00', '17:00', '19:30'];
const SOON_MS = 5 * 60_000;
const hm = (d: Date) => format(d, 'HH:mm');
const at = (day: Date, t: string) => { const d = new Date(day); const [h, m] = t.split(':').map(Number); d.setHours(h, m, 0, 0); return d; };

/** "Posts Today · 9:00 AM" pill: a 7-day × time picker that reschedules on pick. */
function When({ item, now, today, onPick }: { item: CalItem; now: number; today: Date; onPick: (at: Date) => void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const can = movable(item);
  const label = !item.at ? 'Pick a time'
    : `${dayKey(item.at) === dayKey(today) ? 'Today' : dayKey(item.at) === dayKey(addDays(today, 1)) ? 'Tomorrow' : format(item.at, 'EEE d MMM')} · ${format(item.at, 'h:mm a')}`;

  const open = pos !== null;
  const close = () => setPos(null);
  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = pop.current.offsetWidth, h = pop.current.offsetHeight;
    const left = Math.max(16, Math.min(r.left, innerWidth - w - 16));
    const top = r.bottom + h + 16 > innerHeight && r.top > h + 16 ? r.top - h - 8 : r.bottom + 8;
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
    pop.current.querySelector<HTMLElement>('[aria-pressed="true"], button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, pos]);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); btn.current?.focus(); } };
    const shut = (e: Event) => { if (!pop.current?.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    document.addEventListener('scroll', shut, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      document.removeEventListener('scroll', shut, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (!can) return <span className="when-btn is-static tnum"><Icon name="calendar" size={14} />{label}</span>;
  const days = Array.from({ length: 7 }, (_, n) => addDays(today, n));
  const cur = item.at && item.at >= today ? item.at : null;
  const times = cur && !TIMES.includes(hm(cur)) ? [...TIMES, hm(cur)].sort() : TIMES;
  const soon = now + SOON_MS;
  const time = cur ? hm(cur) : '10:00';
  const day = cur ?? today;
  /** Same time on that day, or its first slot still ahead. */
  const firstFree = (d: Date) => [time, ...times].map((t) => at(d, t)).find((x) => x.getTime() >= soon);

  return (
    <>
      <button ref={btn} type="button" className="when-btn tnum" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => (open ? close() : setPos({ left: -9999, top: 0 }))}>
        <Icon name="calendar" size={14} />{label}<Icon name="chevron_down" size={10} className="when-btn__car" />
      </button>
      {open && createPortal(
        <div ref={pop} className="when-pop" role="dialog" aria-label="Pick day and time" style={{ left: pos.left, top: pos.top }}>
          <p className="hr__lbl">Day</p>
          <div className="when-pop__days">
            {days.map((d, n) => (
              <button key={n} type="button" aria-pressed={!!cur && dayKey(d) === dayKey(cur)} disabled={!firstFree(d)} onClick={() => onPick(firstFree(d)!)}>
                {n === 0 ? 'Today' : format(d, 'EEE')}<b className="tnum">{format(d, 'd')}</b>
              </button>
            ))}
          </div>
          <p className="hr__lbl">Time</p>
          <div className="when-pop__times">
            {times.map((t) => (
              <button key={t} type="button" className="tnum" aria-pressed={!!cur && t === hm(cur)} disabled={at(day, t).getTime() < soon}
                onClick={() => { onPick(at(day, t)); close(); }}>
                {format(at(day, t), 'h:mm a')}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
