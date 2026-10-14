'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useApi } from '../../lib/ui/fetcher';

// Kept in sync with lib/demo/shield-script.ts (duplicated here to avoid pulling
// the server AI module into the client bundle). Empty saved prompt => server
// uses its built-in default, so an exact match isn't required for correctness.
const TEMPLATE_VARS = ['brand', 'mention', 'author', 'theme', 'severity', 'source', 'datetime'] as const;

const DEFAULT_SYSTEM_PROMPT = `You are the crisis communications lead for {{brand}}. Write a 60-90 second spoken video response (150-200 words) to this mention:

"{{mention}}"
— by {{author}} · theme: {{theme}} · severity {{severity}}/10 · captured {{datetime}}

Structure: acknowledge → address the specific concern → present facts → state a concrete action → invite further contact. Empathetic but factual, no admission of unproven wrongdoing. NO stage directions, NO [brackets], NO formatting — just the script text itself.`;

/**
 * Editor for the per-user system prompt that drives crisis-response generation.
 * Supports {{variables}} substituted with live mention data at generate time.
 * Empty prompt falls back to the built-in default server-side.
 */
const ResponseSettings: React.FC = () => {
  const { data, mutate } = useApi<{ settings: { systemPrompt: string } }>('/api/shield/settings');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Hydrate from server once loaded (only when the field is still untouched).
  useEffect(() => {
    if (data?.settings && prompt === '') setPrompt(data.settings.systemPrompt ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const insertVar = (v: string) => {
    const token = `{{${v}}}`;
    const el = taRef.current;
    if (!el) { setPrompt(p => p + token); return; }
    const start = el.selectionStart ?? prompt.length;
    const end = el.selectionEnd ?? prompt.length;
    const next = prompt.slice(0, start) + token + prompt.slice(end);
    setPrompt(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      await fetch('/api/shield/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt: prompt }),
      });
      await mutate();
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  const isCustom = prompt.trim().length > 0;

  return (
    <div className="stack">
      <p className="set-hint">
        How the AI writes replies. Leave blank for the default. Variables fill in from the mention.
      </p>
      <div className="row shield-vars">
        {TEMPLATE_VARS.map(v => (
          <button key={v} type="button" className="badge mono" onClick={() => insertVar(v)}>
            {`{{${v}}}`}
          </button>
        ))}
      </div>
      <textarea
        ref={taRef}
        className="input"
        value={prompt}
        onChange={e => { setPrompt(e.target.value); setSaved(false); }}
        placeholder={DEFAULT_SYSTEM_PROMPT}
        rows={8}
        aria-label="Custom AI prompt"
      />
      <div className="set-actions">
        <button className="btn sm primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save prompt'}
        </button>
        <button className="btn sm ghost" onClick={() => { setPrompt(DEFAULT_SYSTEM_PROMPT); setSaved(false); }} disabled={busy}>
          Load default
        </button>
        {isCustom && (
          <button className="btn sm ghost" onClick={() => { setPrompt(''); setSaved(false); }} disabled={busy}>
            Clear
          </button>
        )}
        {saved && <span className="set-ok" role="status">Saved</span>}
      </div>
    </div>
  );
};

export default ResponseSettings;
