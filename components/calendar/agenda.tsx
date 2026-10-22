'use client';

import Link from 'next/link';
import { addDays, format } from 'date-fns';
import { Icon } from '../icons';
import { PLATFORM_LABELS } from '../../lib/ui/platforms';
import { Button } from '../ui';
import { dayKey, idOf, itemMedia, itemPlatforms, kindOf, movable, textsOf, toneOf, type Agenda, type CalItem } from './model';
import { KIND_ICON, Tick } from './review';

export type DropProps = Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;

type Props = {
  ag: Agenda;
  today: Date;
  selId: string | null;
  /** The needs-a-time list is open (collapsed by default so the week isn't pushed down). */
  needOpen: boolean;
  onNeedOpen: (open: boolean) => void;
  /** After a spread: how many still didn't fit. */
  left: number | null;
  spreadBusy: boolean;
  spreadWhy?: string;
  onSpread: () => void;
  onSelect: (it: CalItem) => void;
  /** Just approved: the row's tick draws. */
  just: string[];
  /** Over a platform's character limit. */
  tooLong: (it: CalItem) => boolean;
  composeFor: (day: Date) => string;
  /** Desktop drag: a row onto a day header or an empty day's line. */
  dragging: string | null;
  onDrag: (key: string | null) => void;
  overDay: string | null;
  dropFor: (day: Date) => DropProps;
};

const plats = (it: CalItem) => itemPlatforms(it).map((p) => PLATFORM_LABELS[p] ?? p).join(', ');
export const titleOf = (it: CalItem) =>
  (it.kind === 'draft' && it.draft.title?.trim()) || (Object.values(textsOf(it))[0] ?? (it.kind === 'draft' ? it.draft.body : it.group.text)).split('\n').find((l) => l.trim())?.trim() || 'Untitled post';

/** The week as a list: "Needs a time" first, then each day (empty ones collapse to a line), then Later. */
export function Agenda({ ag, today, selId, needOpen, onNeedOpen, left, spreadBusy, spreadWhy, onSpread, onSelect, just, tooLong, composeFor, dragging, onDrag, overDay, dropFor }: Props) {
  const need = ag.need.length;
  const row = (it: CalItem, where: 'need' | 'day' | 'later') => (
    <Row key={it.key} it={it} where={where} on={idOf(it) === selId} just={just.includes(idOf(it))} long={tooLong(it)}
      dragged={dragging === it.key} onClick={() => onSelect(it)} onDrag={onDrag} />
  );
  const dayName = (d: Date) => format(d, 'EEE d');
  return (
    <nav className={`ag${dragging ? ' is-dragging' : ''}`} aria-label="Posts this week">
      <section className={`ag-need${need ? '' : ' is-clear'}`} aria-label="Needs a time">
        <div className="gh"><Icon name="clock" size={12} /><b>Needs a time</b><span className="n tnum">{need}</span></div>
        <p>
          {left ? <><b>{left} didn’t fit</b>: every day this week is full. Approving gives each the next free slot.</>
            : need ? 'Time passed or never set. Approving one gives it the next free slot.' : 'Every post has a time.'}
        </p>
        <Button size="sm" busy={spreadBusy} disabled={!!spreadWhy} reason={spreadWhy} onClick={onSpread}>
          <Icon name="calendar" size={12} />Spread across the week
        </Button>
        <button type="button" className="disc" aria-expanded={needOpen} disabled={!need} onClick={() => onNeedOpen(!needOpen)}>
          {needOpen ? 'Hide' : 'Show'} {need} post{need === 1 ? '' : 's'} <Icon name="chevron_down" size={12} />
        </button>
        {needOpen && need > 0 && <ul className="rows">{ag.need.map((it) => row(it, 'need'))}</ul>}
      </section>

      {ag.days.map(({ day, items }, k) => {
        const key = dayKey(day);
        const sub = k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : null;
        const drop = dropFor(day);
        if (!items.length) {
          return (
            <div key={key} className={`ag-empty${overDay === key ? ' is-over' : ''}`} {...drop}>
              <b>{dayName(day)}</b>{sub && <span className={k === 0 ? 'today' : ''}>{sub}</span>}<span className="none">nothing planned</span>
              <Link href={composeFor(day)} aria-label={`New post for ${dayName(day)}`}><Icon name="plus" size={12} />New post</Link>
            </div>
          );
        }
        return (
          <section key={key} aria-label={dayName(day)}>
            <div className={`gh${overDay === key ? ' is-over' : ''}`} {...drop}>
              <b>{dayName(day)}</b>{sub && <span className={`sub${k === 0 ? ' today' : ''}`}>{sub}</span>}
              <span className="n tnum">{items.length}</span>
              <Link className="icon-btn" href={composeFor(day)} aria-label={`New post for ${dayName(day)}`}><Icon name="plus" size={12} /></Link>
            </div>
            <ul className="rows">{items.map((it) => row(it, 'day'))}</ul>
          </section>
        );
      })}

      {ag.later.length > 0 && (
        <section aria-label="Later">
          <div className="gh"><b>Later</b><span className="sub">after {format(addDays(today, 6), 'EEE d')}</span><span className="n tnum">{ag.later.length}</span></div>
          <ul className="rows">{ag.later.map((it) => row(it, 'later'))}</ul>
        </section>
      )}
    </nav>
  );
}

function Row({ it, where, on, just, long, dragged, onClick, onDrag }: {
  it: CalItem; where: 'need' | 'day' | 'later'; on: boolean; just: boolean; long: boolean; dragged: boolean; onClick: () => void; onDrag: (key: string | null) => void;
}) {
  const tone = toneOf(it);
  const kind = kindOf(it);
  const can = movable(it);
  const rendering = it.kind === 'draft' && it.draft.rendering && !itemMedia(it);
  const time = where === 'need'
    ? (it.at ? <span className="tm past" title={`Was ${format(it.at, 'EEE d MMM · h:mm a')}`}>{format(it.at, 'EEE d')}</span> : <span className="tm">—</span>)
    : <span className="tm">{format(it.at!, where === 'later' ? 'EEE d' : 'h:mmaaa')}</span>;
  const status = tone === 'review' ? (long ? 'Too long' : rendering ? 'Rendering' : 'Needs review') : tone === 'failed' ? 'Failed' : tone === 'canceled' ? 'Canceled' : 'Approved';
  return (
    <li>
      <button
        type="button"
        data-id={idOf(it)}
        className={`row is-${tone}${rendering ? ' is-rend' : ''}${long ? ' is-long' : ''}${just ? ' is-just' : ''}${dragged ? ' is-dragged' : ''}`}
        aria-current={on}
        onClick={onClick}
        draggable={can || undefined}
        onDragStart={can ? (e) => {
          e.dataTransfer.setData('text/x-cal', it.key);
          e.dataTransfer.effectAllowed = 'move';
          // After the browser snapshots the drag image, so the ghost isn't dimmed.
          setTimeout(() => onDrag(it.key));
        } : undefined}
        onDragEnd={can ? () => onDrag(null) : undefined}
      >
        {time}
        <span className="k" aria-hidden="true"><Icon name={KIND_ICON[kind]} size={12} /></span>
        <span className="t">{titleOf(it)}</span>
        <span className="pd" role="img" aria-label={plats(it)}>{itemPlatforms(it).map((p) => <i key={p} className={p} />)}</span>
        <span className="sd" role="img" aria-label={status} title={status}>{tone !== 'review' && tone !== 'failed' && tone !== 'canceled' && <Tick />}</span>
      </button>
    </li>
  );
}
