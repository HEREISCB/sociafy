'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Button, useToast } from '../ui';
import { useApi, friendlyApiError } from '../../lib/ui/fetcher';

// Kept in sync with lib/demo/shield-script.ts (duplicated here to avoid pulling
// the server AI module into the client bundle). Empty saved prompt => server
// uses its built-in default, so an exact match isn't required for correctness.
const TEMPLATE_VARS = ['brand', 'mention', 'author', 'theme', 'severity', 'source', 'datetime'] as const;

const DEFAULT_SYSTEM_PROMPT = `You are the crisis communications lead for {{brand}}. Write a 60-90 second spoken video response (150-200 words) to this mention:

"{{mention}}"
— by {{author}} · theme: {{theme}} · severity {{severity}}/10 · captured {{datetime}}

Structure: acknowledge → address the specific concern → present facts → state a concrete action → invite further contact. Empathetic but factual, no admission of unproven wrongdoing. NO stage directions, NO [brackets], NO formatting — just the script text itself.`;

/**
 * Editor for the per-user system prompt that drives reply drafting.
 * Supports {{variables}} substituted with live mention data at generate time.
 * Empty prompt falls back to the built-in default server-side.
 */
const ResponseSettings: React.FC = () => {
  const toast = useToast();
  const { data, mutate } = useApi<{ settings: { systemPrompt: string } }>('/api/shield/settings');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Hydrate from server once loaded (only when the field is still untouched).
  useEffect(() => {
    if (data?.settings && prompt === '') setPrompt(data.settings.systemPrompt ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const edit = (next: string) => { setPrompt(next); setMsg(null); };

  const insertVar = (v: string) => {
    const token = `{{${v}}}`;
    const el = taRef.current;
    if (!el) { edit(prompt + token); return; }
    const start = el.selectionStart ?? prompt.length;
    const end = el.selectionEnd ?? prompt.length;
    edit(prompt.slice(0, start) + token + prompt.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  /** Overwrites the textarea, with Undo when there was something to lose. */
  const replace = (next: string, note: string) => {
    const prev = prompt;
    edit(next);
    if (prev.trim() && prev !== next) toast(note, { undo: () => edit(prev) });
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/shield/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt: prompt }),
      });
      // A failed PUT used to report "Saved" anyway.
      if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => '')}`);
      await mutate();
      setMsg({ ok: true, text: prompt.trim() ? 'Saved' : 'Saved · using the default' });
    } catch (e) {
      setMsg({ ok: false, text: `Not saved. ${friendlyApiError(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="set-hint">How the AI writes replies. Leave blank to use ours. Variables fill in from the mention.</p>
      <div className="row shield-vars">
        {TEMPLATE_VARS.map(v => (
          <button key={v} type="button" className="shield-var" onClick={() => insertVar(v)}>
            {`{{${v}}}`}
          </button>
        ))}
      </div>
      <textarea
        ref={taRef}
        className="input"
        value={prompt}
        onChange={e => edit(e.target.value)}
        placeholder="Using the default: acknowledge → address the concern → facts → concrete action → invite contact."
        rows={8}
        aria-label="Reply prompt"
      />
      <div className="set-actions">
        <Button size="sm" variant="primary" busy={busy} onClick={save}>{busy ? 'Saving…' : 'Save prompt'}</Button>
        <button type="button" className="btn sm" onClick={() => replace(DEFAULT_SYSTEM_PROMPT, 'Your prompt was replaced with the default')} disabled={busy}>
          Load default
        </button>
        <button type="button" className="btn sm ghost" onClick={() => replace('', 'Prompt cleared · save to use the default')} disabled={busy || !prompt}>
          Clear
        </button>
        {msg && <span className={msg.ok ? 'set-ok' : 'set-hint err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</span>}
      </div>
    </div>
  );
};

export default ResponseSettings;
