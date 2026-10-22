'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { addDays, format } from 'date-fns';
import { Icon, Pglyph } from '../icons';
import { PLATFORM_LABELS, PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';
import { seekToPoster } from '../../lib/media/motionSeek';
import { KIND_LABEL, dayKey, isVideo, itemMedia, itemPlatforms, kindOf, movable, statusLabel, toneOf, type CalItem } from './model';

export type PostAction = 'cancel' | 'retry' | 'restore' | 'unapprove';
export type Author = { displayName: string | null; handle: string | null; avatarUrl: string | null };

const label = (p: Platform) => PLATFORM_LABELS[p] ?? p;
const n = (x: number) => x.toLocaleString('en-US');
export const KIND_ICON = { text: 'list', image: 'image', video: 'play' } as const;

type Props = {
  item: CalItem;
  index: number;
  total: number;
  /** Which way the user browsed: the pane slides in from that side. */
  dir: number;
  /** Epoch ms, ticking; picks closer than 5 minutes to it are disabled. */
  now: number;
  today: Date;
  limits: Record<Platform, number>;
  /** What each platform posts, as typed (unsaved) or as the server's postText says. */
  texts: Partial<Record<Platform, string>>;
  /** One text for every platform: typing edits them all. */
  same: boolean;
  tab: Platform | undefined;
  /** Accounts that need reconnecting: approve leaves them out. */
  gone: Platform[];
  /** ≈ where "the next free slot" lands, for a post whose time passed. */
  nextSlot: Date | null;
  /** The rendering clip just landed: the frame develops in. */
  developed: boolean;
  /** Autopilot's per-platform versions can be put back (Same text is off and they differ). */
  canRestore: boolean;
  capRef: React.RefObject<HTMLTextAreaElement | null>;
  authorFor: (p: Platform) => Author | undefined;
  onTab: (p: Platform) => void;
  onType: (text: string) => void;
  onDone: () => void;
  onSame: () => void;
  onRestore: () => void;
  onStep: (n: 1 | -1) => void;
  onBack: () => void;
  onReschedule: (at: Date) => void;
};

/** One post up for review. The post card is the editor: each tab shows exactly what that platform posts. Remount per post (key). */
export function ReviewPanel(props: Props) {
  const { item, index, total, dir, now, today, limits, texts, same, gone, nextSlot, developed, canRestore, capRef, authorFor, onTab, onType, onDone, onSame, onRestore, onStep, onBack, onReschedule } = props;
  const draft = item.kind === 'draft' ? item.draft : null;
  const platforms = itemPlatforms(item);
  const tab = props.tab && platforms.includes(props.tab) ? props.tab : platforms[0];
  const tone = toneOf(item);
  const editable = !!draft && !draft.approved;
  const kind = kindOf(item);
  const title = draft?.title?.trim() || firstLine(texts[tab] ?? '') || KIND_LABEL[kind];
  const passed = !!draft && editable && !!item.at && item.at.getTime() < now;
  const text = (tab ? texts[tab] : draft?.body) ?? '';
  const limit = tab ? limits[tab] : undefined;
  const over = (p: Platform) => (texts[p] ?? '').length > (limits[p] ?? Infinity);
  const edited = (p: Platform) => !!draft?.machine && texts[p] !== (draft.machine.perPlatform[p] ?? draft.machine.text);
  const sameWhy = !editable ? 'Approved posts are locked' : platforms.length < 2 ? 'Only one platform' : undefined;
  const a = tab ? authorFor(tab) : undefined;
  const when = item.at && !passed ? slotLabel(item.at, today) : 'next free slot';

  useLayoutEffect(() => {
    const t = capRef.current;
    if (!t) return;
    // field-sizing:content isn't in Firefox: size the text to its content by hand —
    // again whenever its width changes (the phone mounts it hidden, at width 0).
    let w = -1;
    const fit = () => {
      if (t.clientWidth === w) return;
      w = t.clientWidth;
      t.style.height = 'auto';
      t.style.height = `${t.scrollHeight}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(t);
    return () => ro.disconnect();
  }, [text, tab, capRef]);

  return (
    <div className={`rv-in${dir < 0 ? ' is-prev' : dir > 0 ? ' is-next' : ''}`}>
      <div className="rv-back">
        <button type="button" className="btn sm" onClick={onBack}><Icon name="chevron_left" size={14} />This week</button>
        <span className="rv-pos tnum">{index + 1} / {total}</span>
        <button type="button" className="icon-btn" aria-label="Previous post" onClick={() => onStep(-1)}><Icon name="chevron_left" size={14} /></button>
        <button type="button" className="icon-btn" aria-label="Next post" onClick={() => onStep(1)}><Icon name="chevron_right" size={14} /></button>
      </div>
      <div className="rv-head">
        <span className="rv-kind" title={KIND_LABEL[kind]}><Icon name={KIND_ICON[kind]} size={12} /><span>{KIND_LABEL[kind]}</span></span>
        <h2 title={title}>{title}</h2>
        <span className={`badge ${tone === 'review' ? (platforms.some(over) ? 'err' : 'accent') : tone === 'failed' ? 'err' : tone === 'canceled' ? '' : 'ok'}`}>
          <span className="d" />{tone === 'review' && platforms.some(over) ? 'Too long' : draft?.rendering && !itemMedia(item) && tone === 'review' ? 'Rendering' : statusLabel(item)}
        </span>
        <span className="rv-nav">
          <span className="rv-pos tnum">{index + 1} / {total}</span>
          <button type="button" className="icon-btn" aria-label="Previous post" onClick={() => onStep(-1)}><Icon name="chevron_left" size={14} /></button>
          <button type="button" className="icon-btn" aria-label="Next post" onClick={() => onStep(1)}><Icon name="chevron_right" size={14} /></button>
        </span>
      </div>

      <div className="rv-when">
        <When item={item} now={now} today={today} onPick={onReschedule} />
        {passed && <span className="rv-passed" title={nextSlot ? `Approving gives it the next free slot, ≈ ${slotLabel(nextSlot, today)}` : undefined}><Icon name="alert" size={12} /><span>{format(item.at!, 'EEE d · h:mm a')} passed. Gets the next free slot.</span></span>}
        {editable && !item.at && <span className="rv-passed">No time yet. Gets the next free slot.</span>}
      </div>

      <div className="ptabs">
        <div className="tabs" role="tablist" aria-label="What each platform posts">
          {platforms.map((p) => (
            <button key={p} type="button" role="tab" className="ptab" aria-selected={p === tab} onClick={() => onTab(p)}>
              <Pglyph p={PLATFORM_TO_SHORT[p]} />
              <span className="nm">{label(p)}</span>
              {gone.includes(p) && <span className="wn" title={`${label(p)} needs reconnecting`}><Icon name="alert" size={12} /></span>}
              {edited(p) && <span className="ed" title="Edited by you" />}
              <span className={`c tnum${over(p) ? ' over' : ''}`}>{n((texts[p] ?? '').length)}</span>
            </button>
          ))}
          {!platforms.length && <span className="rv-note">No platforms. Open in Compose to pick some.</span>}
        </div>
        <button type="button" className="same" role="switch" aria-checked={same} disabled={!!sameWhy} title={sameWhy} onClick={onSame}>
          <span className="sw" aria-hidden="true" /><span className="long">Same text everywhere</span><span className="short">Same text</span>
        </button>
      </div>
      {editable && !same && canRestore && (
        <p className="rv-note rv-restore">Each platform has its own text. <button type="button" className="linkish" onClick={onRestore}>Restore Autopilot’s versions</button></p>
      )}

      <div className="rv-grid">
        <article className="post" aria-label={tab ? `${label(tab)} post` : 'Post'}>
          <header className="post-h">
            {tab && <Avatar author={a} p={tab} />}
            <div>
              <b>{a?.displayName?.trim() || a?.handle?.trim() || 'You'}</b>
              <span>{[tab && label(tab), when].filter(Boolean).join(' · ')}</span>
            </div>
          </header>
          {tab && gone.includes(tab) && (
            <p className="rv-gone"><Icon name="alert" size={12} /><span>{label(tab)} needs reconnecting. Approving leaves it out. <Link href="/settings/connections">Reconnect</Link> first to include it.</span></p>
          )}
          <div className="txwrap">
            <textarea
              ref={capRef}
              className="tx"
              rows={3}
              value={text}
              readOnly={!editable}
              aria-label={same && platforms.length > 1 ? 'Text for every platform' : tab ? `${label(tab)} text` : 'Text'}
              onChange={(e) => onType(e.target.value)}
              onBlur={() => { if (editable) onDone(); }}
              onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); }}
            />
          </div>
          <div className="txbar">
            <span className="ed">{editable ? <><Icon name="edit" size={12} />{same && platforms.length > 1 ? 'Click the text to edit it for every platform' : `Click the text to edit what ${tab ? label(tab) : 'it'} posts`}</>
              : tone === 'pending' || tone === 'waiting' ? 'Approved posts are locked. Undo or move it back to review to edit.' : 'This post can’t be edited here.'}</span>
            <span className="on">{same && platforms.length > 1 ? 'Editing every platform' : `Editing ${tab ? label(tab) : 'the text'}`} · <kbd>Esc</kbd> to finish</span>
            {limit != null && <span className={`cnt tnum${tab && over(tab) ? ' over' : ''}`}>{n(text.length)} / {n(limit)}</span>}
          </div>
          <Media item={item} now={now} developed={developed} />
        </article>

        <div className="rv-aside">
          <div><p className="k">Goes to</p><p>{platforms.length ? platforms.map(label).join(', ') : '—'}</p></div>
          {draft?.rationale && (
            <details>
              <summary>Why this {draft.score != null && <span className="score tnum">{draft.score}</span>}<Icon name="chevron_down" size={12} /></summary>
              <p>{draft.rationale}</p>
            </details>
          )}
          <div className="rv-compose">
            {editable
              ? <Link className="btn sm" href={`/compose?draft=${draft.id}`}><Icon name="edit" size={12} />Open in Compose</Link>
              : <button type="button" className="btn sm" disabled><Icon name="edit" size={12} />Open in Compose</button>}
            <span className="why">{editable ? 'Change media, format or platforms' : 'Only posts in review open in Compose'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const firstLine = (t: string) => t.split('\n').find((l) => l.trim())?.trim().slice(0, 90) ?? '';

/** The account's picture, or its first letter when there's none or it fails to load (expired CDN links). */
function Avatar({ author, p }: { author?: Author; p: Platform }) {
  const [broken, setBroken] = useState(false);
  const name = author?.displayName?.trim() || author?.handle?.trim() || label(p);
  return (
    <span className="av" aria-hidden="true">
      {author?.avatarUrl && !broken
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={author.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : name[0]?.toUpperCase()}
      <Pglyph p={PLATFORM_TO_SHORT[p]} className="av-pl" />
    </span>
  );
}

/** The real media frame: a rendering clip says so (and develops in when it lands), images and videos show as posted. */
function Media({ item, now, developed }: { item: CalItem; now: number; developed: boolean }) {
  const m = itemMedia(item);
  if (kindOf(item) === 'text') return null;
  const rendering = item.kind === 'draft' && item.draft.rendering && !m;
  const mins = item.kind === 'draft' && now ? Math.max(0, Math.round((now - new Date(item.draft.createdAt).getTime()) / 60_000)) : 0;
  return (
    <div className="frame">
      {rendering ? (
        <div className="frame-state" role="status">
          <b>Rendering the video</b>
          <span className="tnum frame-timer">drafted {mins} min ago · checks every 10 s</span>
          <span>{item.kind === 'draft' && item.draft.approved ? 'Approved. It posts when the clip lands.' : 'Approve now and it posts when the clip lands. It develops here when it’s ready.'}</span>
        </div>
      ) : m ? (
        <div key={m.url} className={`frame-art${developed ? ' develop' : ''}`}>
          {isVideo(m)
            ? <video src={m.url} poster={m.posterUrl} controls muted playsInline preload="metadata" onLoadedMetadata={m.posterUrl ? undefined : seekToPoster} />
            // eslint-disable-next-line @next/next/no-img-element
            : <img src={m.url} alt="" />}
        </div>
      ) : <div className="frame-state is-empty">No media yet.</div>}
    </div>
  );
}

export const slotLabel = (d: Date, today: Date) =>
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
  const label = !item.at ? 'Pick a time' : !cur && item.kind === 'draft' && !item.draft.approved ? 'Pick a new time' : `Posts ${slotLabel(item.at, today)}`;

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
