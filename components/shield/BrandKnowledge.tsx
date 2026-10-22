'use client';

import React, { useState } from 'react';
import { Button, useToast } from '../ui';
import { useApi, friendlyApiError } from '../../lib/ui/fetcher';
import { Icon } from '../icons';
import { keepaliveFetch, useDeferred } from '../settings-ui';

export interface ShieldDocument {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
}

/** fetch → throws "<status>: <body>" on a non-2xx, so a failure can't read as "saved". */
async function send(url: string, method: 'POST' | 'PATCH', body: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => '')}`);
}

/**
 * Reply knowledge: .txt/.md reference docs (approved lines, policies, facts)
 * the AI grounds mention replies in. Separate from the Brand kit.
 */
const BrandKnowledge: React.FC = () => {
  const toast = useToast();
  const defer = useDeferred();
  const { data, mutate } = useApi<{ documents: ShieldDocument[] }>('/api/shield/documents');
  const [gone, setGone] = useState<string[]>([]);
  const docs = (data?.documents ?? []).filter((d) => !gone.includes(d.id));

  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setDraftContent(text.slice(0, 50_000));
    if (!draftTitle.trim()) setDraftTitle(file.name.replace(/\.(txt|md|markdown)$/i, ''));
  };

  const add = async () => {
    if (!draftContent.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await send('/api/shield/documents', 'POST', { title: draftTitle.trim(), content: draftContent });
      setDraftTitle('');
      setDraftContent('');
      await mutate();
      toast('Document added');
    } catch (e) {
      setError(`Not added. ${friendlyApiError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (id: string, title: string, content: string) => {
    setBusy(true);
    setError(null);
    try {
      await send(`/api/shield/documents/${id}`, 'PATCH', { title, content });
      setEditingId(null);
      await mutate();
      toast('Document saved');
    } catch (e) {
      setError(`Not saved. ${friendlyApiError(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Deleting waits behind an Undo toast; the DELETE goes out after.
  const remove = (doc: ShieldDocument) => {
    setGone((g) => [...g, doc.id]);
    defer(
      `Deleted “${doc.title}”`,
      async () => {
        const r = await keepaliveFetch(`/api/shield/documents/${doc.id}`, 'DELETE').catch(() => null);
        if (!r?.ok) {
          setGone((g) => g.filter((x) => x !== doc.id));
          toast(`Couldn’t delete “${doc.title}”. It’s still here.`, { tone: 'err' });
          return;
        }
        await mutate();
      },
      () => setGone((g) => g.filter((x) => x !== doc.id)),
    );
  };

  return (
    <div className="stack">
      <p className="set-hint">
        Facts, policies and approved lines the AI grounds replies in. Separate from your Brand kit. Paste text or upload a .txt or .md file.
      </p>

      {docs.length > 0 && (
        <div className="shield-docs">
          {docs.map(doc => (
            <DocRow
              key={doc.id}
              doc={doc}
              editing={editingId === doc.id}
              busy={busy}
              onEdit={() => setEditingId(doc.id)}
              onCancel={() => setEditingId(null)}
              onSave={saveEdit}
              onDelete={remove}
            />
          ))}
        </div>
      )}

      <div className="row shield-doc-new">
        <input
          className="input"
          type="text"
          value={draftTitle}
          onChange={e => setDraftTitle(e.target.value)}
          placeholder="Document title"
          aria-label="Document title"
        />
        <label className="btn sm">
          <Icon name="upload" size={12} /> Upload .txt / .md
          <input
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            onChange={e => onFile(e.target.files?.[0])}
            hidden
          />
        </label>
      </div>
      <textarea
        className="input"
        value={draftContent}
        onChange={e => setDraftContent(e.target.value)}
        placeholder="Or paste text…"
        rows={4}
        aria-label="Document text"
      />
      <div className="set-actions">
        <Button size="sm" variant="primary" busy={busy && !editingId} disabled={busy || !draftContent.trim()} reason="Paste or upload text first" onClick={add}>
          Add document
        </Button>
        <span className="set-num">{draftContent.length.toLocaleString()} chars</span>
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
    </div>
  );
};

const DocRow: React.FC<{
  doc: ShieldDocument;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (id: string, title: string, content: string) => void;
  onDelete: (doc: ShieldDocument) => void;
}> = ({ doc, editing, busy, onEdit, onCancel, onSave, onDelete }) => {
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content);

  if (!editing) {
    return (
      <div className="shield-doc">
        <div className="shield-doc-main">
          <div className="set-label">{doc.title}</div>
          <div className="set-num">{doc.content.length.toLocaleString()} chars</div>
        </div>
        <button type="button" className="btn sm" onClick={onEdit} disabled={busy}>Edit</button>
        <button type="button" className="icon-btn" onClick={() => onDelete(doc)} disabled={busy} aria-label={`Delete ${doc.title}`}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="shield-doc editing">
      <input className="input" type="text" value={title} onChange={e => setTitle(e.target.value)} aria-label="Document title" />
      <textarea className="input" value={content} onChange={e => setContent(e.target.value)} rows={6} aria-label="Document text" />
      <div className="set-actions">
        <Button size="sm" variant="primary" busy={busy} onClick={() => onSave(doc.id, title.trim() || 'Untitled', content)}>Save</Button>
        <button type="button" className="btn sm ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
};

export default BrandKnowledge;
