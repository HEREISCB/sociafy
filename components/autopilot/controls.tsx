'use client';

// Autopilot + onboarding controls that components/ui.tsx doesn't have yet:
// a −/+ stepper, a "Saved" tick and the topic picker. Seg, toast and the
// pinned bar come from ui.tsx.

import React, { useEffect, useState } from 'react';
import { useToast } from '../ui';
import { Icon } from '../icons';
import { TOPICS, parseTopic, topicLabel } from '../../lib/agent/topics';

export function Stepper({ value, min, max, onChange, label, disabled }: {
  value: number; min: number; max: number; onChange: (v: number) => void; label: string; disabled?: boolean;
}) {
  return (
    <div className="ap-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>−</button>
      <output aria-live="polite">{value}</output>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

/** "Saved" tick beside a section title: on for 1.6 s after `at` changes. */
export function Saved({ at }: { at: number }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!at) return;
    queueMicrotask(() => setOn(true));
    const t = setTimeout(() => setOn(false), 1_600);
    return () => clearTimeout(t);
  }, [at]);
  return (
    <span className={`ap-saved${on ? ' is-on' : ''}`} aria-hidden={!on}>
      <Icon name="check" size={12} />Saved
    </span>
  );
}

/**
 * Type-and-Enter topic input, the selected topics (× removes, with Undo) and
 * popular starters. `onChange` gets the whole next list.
 */
export function TopicPicker({ id, value, onChange, disabled }: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  // Chips added this visit pop in; ones loaded with the page don't.
  const [added, setAdded] = useState<string | null>(null);
  const add = (t: string) => {
    setAdded(t);
    if (!value.includes(t)) onChange([...value, t]);
  };
  const submit = () => {
    const r = parseTopic(text);
    if (!r) return;
    if ('error' in r) { setHint(r.error); return; }
    setHint(null);
    setText('');
    add(r.id);
  };
  const remove = (t: string) => {
    const before = value;
    onChange(value.filter((x) => x !== t));
    toast(`Removed “${topicLabel(t)}”`, { undo: () => onChange(before) });
  };
  return (
    <div className="ap-topics">
      <form className="ap-addrow" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input
          id={id} className="input" value={text} disabled={disabled} aria-label={id ? undefined : 'Add a topic'}
          onChange={(e) => { setText(e.target.value); setHint(null); }}
          placeholder="Type a topic and press Enter, e.g. home brewing"
        />
        <button type="submit" className="btn" disabled={disabled || !text.trim()}>Add</button>
      </form>
      <p className={`ap-note${hint ? ' is-err' : ''}`} role={hint ? 'alert' : undefined}>{hint ?? 'Short is best: “filter coffee”, not a sentence.'}</p>
      <div className="ap-sub">Your topics ({value.length})</div>
      <div className="ap-chips">
        {value.length ? value.map((t) => (
          <span key={t} className={`ap-chip is-mine${added === t ? ' is-in' : ''}`}>
            {topicLabel(t)}
            <button type="button" aria-label={`Remove ${topicLabel(t)}`} disabled={disabled} onClick={() => remove(t)}><Icon name="x" size={12} /></button>
          </span>
        )) : <span className="ap-note">No topics yet. Pick one below or type your own.</span>}
      </div>
      <div className="ap-sub">Popular</div>
      <div className="ap-chips">
        {TOPICS.filter((t) => !value.includes(t.id)).map((t) => (
          <button key={t.id} type="button" className="ap-chip" disabled={disabled} onClick={() => add(t.id)}>
            <Icon name="plus" size={12} />{t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
