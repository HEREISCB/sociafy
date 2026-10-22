'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { addDays, format } from 'date-fns';
import { Icon, Pglyph } from '../icons';
import { PLATFORM_LABELS, PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';
import { Glyphs } from './glyphs';
import { seekToPoster } from '../../lib/media/motionSeek';
import {
  KIND_LABEL, dayKey, isVideo, itemMedia, itemPlatforms, kindOf, movable, statusLabel, textFor, tightestLimit, toneOf, type CalItem,
} from './model';

export type PostAction = 'cancel' | 'retry' | 'restore' | 'unapprove';
export type Author = { displayName: string | null; handle: string | null; avatarUrl: string | null };

const label = (p: Platform) => PLATFORM_LABELS[p] ?? p;
const n = (x: number) => x.toLocaleString('en-US');

type Props = {
  item: CalItem;
  index: number;
  total: number;
  /** Which way the user browsed: the edit pane slides in from that side. */
  dir: number;
  /** Epoch ms, ticking; picks closer than 5 minutes to it are disabled. */
  now: number;
  today: Date;
  limits: Record<Platform, number>;
  /** The caption as edited (owned by Home so the decision bar approves what's typed). */
  body: string;
  over: Platform[];
  /** The rendering clip just landed: the frame develops in. */
  developed: boolean;
  capRef: React.RefObject<HTMLTextAreaElement | null>;
  authorFor: (p: Platform) => Author | undefined;
  onBody: (body: string) => void;
  onSaveBody: (body: string) => void;
  onStep: (n: 1 | -1) => void;
  onReschedule: (at: Date) => void;
};

/** One post up for review, in Compose's order: edit on the left, the platform-true preview on the right. Remount per post (key). */
export function ReviewPanel({ item, index, total, dir, now, today, limits, body, over, developed, capRef, authorFor, onBody, onSaveBody, onStep, onReschedule }: Props) {
  const draft = item.kind === 'draft' ? item.draft : null;
  const platforms = itemPlatforms(item);
  const tone = toneOf(item);
  const editable = !!draft && !draft.approved;
  const tight = tightestLimit(platforms, limits);
  const kind = KIND_LABEL[kindOf(item)];
  const topic = draft?.title?.trim();
  const noSlot = !!draft && !draft.approved && (!item.at || draft.overdue);

  return (
    <div className="hr">
      <section className={`hr-ed${dir < 0 ? ' is-prev' : dir > 0 ? ' is-next' : ''}`} aria-label="Edit post">
        <div className="hr-ed__meta">
          <span className="hr-ed__kind">{kind}</span>
          {topic && <span className="hr-ed__topic">· {topic}</span>}
          <span className={`hr-chip hr-chip--${over.length && tone === 'review' ? 'failed' : tone}`}>{over.length && tone === 'review' ? 'Too long' : statusLabel(item)}</span>
          <span className="hr-ed__nav">
            <span className="hr-ed__pos tnum">{index + 1} / {total}</span>
            <button type="button" className="icon-btn" aria-label="Previous post" onClick={() => onStep(-1)}><Icon name="chevron_left" size={14} /></button>
            <button type="button" className="icon-btn" aria-label="Next post" onClick={() => onStep(1)}><Icon name="chevron_right" size={14} /></button>
          </span>
        </div>

        <div>
          <label className="hr-lbl" htmlFor="hr-cap">
            <b>Caption</b>
            {tight && <span className={`hr-count${over.length ? ' is-over' : ''}`}>{n(body.length)} / {n(tight.limit)} · {label(tight.platform)}</span>}
          </label>
          <textarea
            id="hr-cap"
            ref={capRef}
            className="input hr-cap"
            rows={6}
            value={body}
            readOnly={!editable}
            onChange={(e) => onBody(e.target.value)}
            onBlur={() => { if (draft && editable && body !== draft.body) onSaveBody(body); }}
            onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); }}
          />
          {over.length > 0 && (
            <p className="hr-warn" role="status">
              Too long for {over.map((p) => `${label(p)} (${n(body.length)}/${n(limits[p])})`).join(', ')}. Trim it, or open in Compose to drop {over.map(label).join(', ')}.
            </p>
          )}
          {!editable && (
            <p className="hr-note">
              {tone === 'pending' || tone === 'waiting' ? 'Approved posts are locked. Move it back to review, or cancel and edit in Compose.' : 'This post can’t be edited here.'}
            </p>
          )}
        </div>

        <div className="hr-row">
          <span className="hr-row__l">Goes to</span>
          <span className="hr-plats">
            {platforms.length ? platforms.map((p) => <span key={p} className="hr-plat"><Glyphs platforms={[p]} />{label(p)}</span>)
              : <span className="hr-note">No platforms. Open in Compose to pick some.</span>}
          </span>
        </div>

        <div className="hr-row">
          <span className="hr-row__l">Posts</span>
          <span className="hr-plats">
            <When item={item} now={now} today={today} onPick={onReschedule} />
            {noSlot && <span className="hr-note">{item.at ? 'This time passed.' : ''} Approving gives it the next free slot.</span>}
          </span>
        </div>

        {draft?.rationale && <p className="hr-why"><b>Why this</b>{draft.rationale}</p>}

        <div className="hr-row">
          {editable
            ? <Link className="btn sm" href={`/compose?draft=${draft.id}`}><Icon name="edit" size={12} />Open in Compose</Link>
            : <button type="button" className="btn sm" disabled><Icon name="edit" size={12} />Open in Compose</button>}
          <span className="hr-note">{editable ? 'Change media, format or platforms' : 'Only drafts in review open in Compose'}</span>
        </div>
      </section>

      <Preview item={item} body={body} platforms={platforms} now={now} today={today} developed={developed} over={over} authorFor={authorFor} />
    </div>
  );
}

/** How it reads on each platform: one tab per platform, the feed's fold, the real media frame. */
function Preview({ item, body, platforms, now, today, developed, over, authorFor }: {
  item: CalItem; body: string; platforms: Platform[]; now: number; today: Date; developed: boolean; over: Platform[]; authorFor: (p: Platform) => Author | undefined;
}) {
  const [pick, setPick] = useState<Platform | null>(null);
  const active = pick && platforms.includes(pick) ? pick : platforms[0];
  const [more, setMore] = useState(false);
  const [clamped, setClamped] = useState(false);
  const cap = useRef<HTMLParagraphElement>(null);
  const text = active ? textFor(item, active, body) : body;
  const m = itemMedia(item);
  const isText = kindOf(item) === 'text';
  useLayoutEffect(() => {
    const el = cap.current;
    if (!el || more) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, more]);

  const a = active ? authorFor(active) : undefined;
  const name = a?.displayName?.trim() || a?.handle?.trim() || 'You';
  const differ = platforms.some((p) => textFor(item, p, body) !== body);
  const rendering = item.kind === 'draft' && item.draft.rendering && !m;
  const mins = item.kind === 'draft' && now ? Math.max(0, Math.round((now - new Date(item.draft.createdAt).getTime()) / 60_000)) : 0;

  return (
    <section className="hr-pv" aria-label="Preview">
      <div className="hr-ptabs" role="tablist" aria-label="Preview platform">
        {platforms.map((p) => (
          <button key={p} type="button" role="tab" aria-selected={p === active} className="hr-ptab" onClick={() => setPick(p)}>{label(p)}</button>
        ))}
        {!platforms.length && <span className="hr-note">No platform to preview.</span>}
      </div>
      <article className="hr-post">
        <header className="hr-post__head">
          {a?.avatarUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="hr-post__av" src={a.avatarUrl} alt="" referrerPolicy="no-referrer" />
            : active ? <Pglyph p={PLATFORM_TO_SHORT[active]} size="lg" /> : <span className="hr-post__av" />}
          <div>
            <b className="hr-post__name">{name}</b>
            <span className="hr-note">{[active && label(active), item.at && !(item.kind === 'draft' && item.draft.overdue) ? slotLabel(item.at, today) : 'next free slot'].filter(Boolean).join(' · ')}</span>
          </div>
        </header>
        <p ref={cap} className={`hr-post__text${more ? '' : isText ? ' is-long' : ' is-clamped'}`}>{text}</p>
        {(clamped || more) && (
          <button type="button" className="hr-post__more" aria-expanded={more} onClick={() => setMore((v) => !v)}>{more ? 'Show less' : '…more'}</button>
        )}
        {!isText && (
          <div className="hr-frame">
            {rendering ? (
              <div className="hr-frame__state" role="status">
                <b>Rendering the video</b>
                <span className="tnum hr-frame__timer">drafted {mins} min ago · checks every 10 s</span>
                <span>{item.kind === 'draft' && item.draft.approved ? 'Approved. It posts when the clip lands.' : 'Approve now and it posts when the clip lands. It develops here when it’s ready.'}</span>
              </div>
            ) : m ? (
              <div key={m.url} className={`hr-frame__art${developed ? ' develop' : ''}`}>
                {isVideo(m)
                  ? <video src={m.url} poster={m.posterUrl} controls muted playsInline preload="metadata" onLoadedMetadata={m.posterUrl ? undefined : seekToPoster} />
                  // eslint-disable-next-line @next/next/no-img-element
                  : <img src={m.url} alt="" />}
              </div>
            ) : <div className="hr-frame__state is-empty">No media yet.</div>}
          </div>
        )}
      </article>
      <p className="hr-note hr-pv__foot">
        {over.length ? <span className="hr-err">Too long for {over.map(label).join(', ')}</span> : differ ? 'Each platform has its own copy' : 'Same caption on every platform'}
      </p>
    </section>
  );
}

const slotLabel = (d: Date, today: Date) =>
  `${dayKey(d) === dayKey(today) ? 'Today' : dayKey(d) === dayKey(addDays(today, 1)) ? 'Tomorrow' : format(d, 'EEE d MMM')} · ${format(d, 'h:mm a')}`;

export function Tick() {
  return (
    <svg className="tick" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path pathLength={1} d="M2.5 6.4l2.4 2.3 4.6-5" />
    </svg>
  );
}

/** Hand-picked slots; the post's own time is added when it isn't one of them. */
const TIMES = ['08:00', '09:00', '10:00', '12:00', '13:00', '15:00', '17:00', '19:30'];
const SOON_MS = 5 * 60_000;
const hm = (d: Date) => format(d, 'HH:mm');
const at = (day: Date, t: string) => { const d = new Date(day); const [h, m] = t.split(':').map(Number); d.setHours(h, m, 0, 0); return d; };

/** "Posts Today · 9:00 AM" pill: a 7-day × time picker that reschedules on pick. Disabled (with why) when the post can't move. */
function When({ item, now, today, onPick }: { item: CalItem; now: number; today: Date; onPick: (at: Date) => void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const can = movable(item);
  // A passed time isn't a choice: show it as needing a slot.
  const cur = item.at && item.at >= today && item.at.getTime() >= now ? item.at : null;
  const label = !item.at ? 'Pick a time' : item.kind === 'draft' && item.draft.overdue ? 'Pick a new time' : slotLabel(item.at, today);

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

  if (!can) {
    return (
      <button type="button" className="when-btn tnum" disabled title="Approved posts keep their time. Move it back to review to change it.">
        <Icon name="calendar" size={14} />{label}
      </button>
    );
  }
  const days = Array.from({ length: 7 }, (_, k) => addDays(today, k));
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
          <p className="when-pop__l">Day</p>
          <div className="when-pop__days">
            {days.map((d, k) => (
              <button key={k} type="button" aria-pressed={!!cur && dayKey(d) === dayKey(cur)} disabled={!firstFree(d)} onClick={() => onPick(firstFree(d)!)}>
                {k === 0 ? 'Today' : format(d, 'EEE')}<b className="tnum">{format(d, 'd')}</b>
              </button>
            ))}
          </div>
          <p className="when-pop__l">Time</p>
          <div className="when-pop__times">
            {times.map((t) => (
              <button key={t} type="button" className="tnum" aria-pressed={!!cur && t === hm(cur)} disabled={at(day, t).getTime() < soon}
                title={at(day, t).getTime() < soon ? 'Already passed' : undefined}
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
