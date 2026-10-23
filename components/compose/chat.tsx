'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { Icon } from '../icons';
import { priceForCompose, priceForMotionAiEdit } from '../../lib/credits/pricing';
import type { Platform } from '../../lib/db/schema';
import { RenderStatus, type Render } from './generate';
import type { MediaItem } from './attachments';
import { editing as editWait, editFailCopy, followMotionEdit, startMotionEdit } from './motion-editor';

/** `local` lines (errors, edit-mode turns) never go to the brief model. */
type Msg = { role: 'user' | 'assistant'; content: string; local?: boolean };
type Credits = { balance: number; needed: number };

const BRIEF_COST = priceForCompose({ withTools: false }).credits;

/**
 * Compose's chat, a side drawer. Brief mode: talk the Brief (the prompt for the
 * caption, image and video) into shape, plus length and platforms. Edit mode,
 * once this session rendered an editable AI motion graphic: each message is a
 * whole-video edit of it, swapped in when done. Stays mounted while closed so
 * the conversation and a running edit survive.
 */
export function ComposeChat({ open, onClose, body, setBody, platforms, connected, onPlatforms, setLength, video, onSwap, onCredits, onCharged }: {
  open: boolean;
  onClose: () => void;
  /** The Brief. */
  body: string;
  setBody: (s: string) => void;
  platforms: Platform[];
  connected: Platform[];
  onPlatforms: (ps: Platform[]) => void;
  setLength: (n: number | null) => void;
  /** The last video rendered in this session, while it's still attached. */
  video: MediaItem | null;
  onSwap: (old: MediaItem, next: MediaItem) => void;
  onCredits: (e: Credits) => void;
  onCharged: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [render, setRender] = useState<Render | null>(null);
  /** Edit info for `video`: its length (for the price), or not editable. */
  const [info, setInfo] = useState<{ id: string; durationSec: number | null } | null>(null);
  /** The video id the user chose to re-brief instead of edit. */
  const [rebrief, setRebrief] = useState<string | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [msgs.length, render, open]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, onClose]);

  // Only AI motion graphics with an editable job can be edited; the segments view is the check (404 = no).
  const vid = video?.motionAi && video.id ? video.id : null;
  useEffect(() => {
    if (!vid) return;
    let off = false;
    fetch(`/api/media/motion-ai/${vid}/segments`, { credentials: 'include' })
      .then(async (r) => (r.ok ? ((await r.json()) as { durationSec?: number }).durationSec ?? null : null))
      .catch(() => null)
      .then((d) => { if (!off) setInfo({ id: vid, durationSec: d }); });
    return () => { off = true; };
  }, [vid]);

  const editable = Boolean(vid && info?.id === vid && info.durationSec);
  const editing = editable && rebrief !== vid;
  const cost = editing ? priceForMotionAiEdit(info!.durationSec!).credits : BRIEF_COST;
  const say = (content: string, local = false) => { if (alive.current) setMsgs((m) => [...m, { role: 'assistant', content, local }]); };

  const brief = async (history: Msg[]) => {
    try {
      const r = await fetch('/api/compose/chat', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history.filter((m) => !m.local).slice(-20).map(({ role, content }) => ({ role, content })), body, platforms }),
      });
      const d = (await r.json().catch(() => ({}))) as { reply?: string; post?: string; durationSec?: number; platforms?: Platform[]; error?: string; hint?: string; balance?: number; needed?: number };
      if (r.status === 402 && d.error === 'insufficient_credits') { onCredits({ balance: Number(d.balance ?? 0), needed: Number(d.needed ?? 0) }); say('Not enough credits for that.', true); return; }
      if (!r.ok || !d.reply) { say(d.hint ?? (r.status === 429 ? 'Too many messages. Wait a minute and try again.' : 'Couldn’t get a reply. Try again.'), true); return; }
      onCharged();
      say(d.reply);
      if (d.post) setBody(d.post);
      if (d.durationSec) setLength(d.durationSec);
      const ps = d.platforms?.filter((p) => connected.includes(p)) ?? [];
      if (ps.length) onPlatforms(ps);
    } catch {
      say('Couldn’t get a reply. Check your connection and try again.', true);
    }
  };

  const edit = async (v: MediaItem, instruction: string) => {
    const out = await startMotionEdit(v.id!, instruction);
    if ('credits' in out) { onCredits(out.credits); say('Not enough credits for that edit.', true); return; }
    if ('error' in out) { say(out.error, true); return; }
    onCharged();
    say('On it. Editing the whole video.', true);
    const dur = info?.id === v.id ? info?.durationSec : null;
    setRender({ startedAt: Date.now(), ...editWait(dur) });
    const res = await followMotionEdit(out.jobId, dur);
    if (!alive.current) return;
    setRender(null);
    if ('asset' in res && res.asset) {
      const a = res.asset;
      onSwap(v, { id: a.id, url: a.publicUrl, mimeType: a.mimeType, label: a.label || 'Motion graphic (edited)', aspect: v.aspect, motionAi: true, ...(a.posterUrl ? { posterUrl: a.posterUrl } : {}) });
      say('Done. The edited version replaced the video in your post. Tell me if anything else should change.', true);
    } else {
      say(editFailCopy(res.failed), true);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...msgs, { role: 'user' as const, content: text, local: editing }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      if (editing && video) await edit(video, text);
      else await brief(next);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <m.section
          id="compose-chat" className="chat-panel" aria-label={editing ? 'Edit the video by chat' : 'Brief by chat'}
          initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }}
          transition={{ duration: 0.28, ease: [0.65, 0, 0.35, 1] }}
        >
          <header className="chat-head">
            <h2>{editing ? 'Edit the video' : 'Ask AI'}</h2>
            <span className="compose-note">{editing ? 'Each message edits the whole video' : 'Shapes the brief, not the caption'}</span>
            <button type="button" className="icon-btn" aria-label="Close chat" onClick={onClose}><Icon name="x" size={14} /></button>
          </header>
          {video && !editing && (
            <p className="compose-note">
              {editable
                ? <>Re-briefing rewrites the brief; Generate makes a new video. <button type="button" className="chat-link" onClick={() => setRebrief(null)}>Edit the current video instead</button></>
                : vid && info?.id !== vid ? 'Checking whether this video can be edited…'
                : 'This video can’t be edited by chat (AI footage and templates aren’t). Tell me what to change and I’ll rewrite the brief, then Generate makes a new one.'}
            </p>
          )}
          {editing && (
            <p className="compose-note">
              Each message edits the whole video. <button type="button" className="chat-link" disabled={busy} onClick={() => setRebrief(vid)}>Re-brief instead</button>
            </p>
          )}
          <div ref={list} className="chat-log" role="log" aria-live="polite" aria-busy={busy}>
            {msgs.length === 0 && (
              <p className="compose-note">
                {editing ? 'What should change? e.g. “make the headline bigger and the music quieter”.' : 'Tell me about the post and I’ll write the brief, e.g. “a 15s video for my bakery’s new croissant, warm tone, for Instagram”.'}
              </p>
            )}
            {msgs.map((m, i) => (
              <p key={i} className={`chat-msg chat-msg--${m.role}`}>
                <span className="sr-only">{m.role === 'user' ? 'You: ' : 'Assistant: '}</span>{m.content}
              </p>
            ))}
            {busy && !render && <p className="compose-note">Thinking…</p>}
          </div>
          {render && <RenderStatus render={render} />}
          <div className="chat-input">
            <label htmlFor="compose-chat-input" className="sr-only">Message</label>
            <textarea
              id="compose-chat-input"
              className="input"
              rows={2}
              maxLength={editing ? 1_000 : 2_000}
              value={input}
              disabled={busy}
              autoFocus
              placeholder={editing ? 'Describe the change…' : 'Describe the post…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            />
            <button type="button" className="btn primary sm" disabled={busy || !input.trim()} onClick={() => void send()}>
              {render ? 'Editing…' : busy ? 'Sending…' : 'Send'} <span className="compose-cost">{cost} cr</span>
            </button>
          </div>
        </m.section>
      )}
    </AnimatePresence>
  );
}
