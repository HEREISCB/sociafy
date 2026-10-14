'use client';

import React, { useState } from 'react';
import { useApi } from '../../lib/ui/fetcher';
import { Icon } from '../icons';

export interface ShieldDocument {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
}

/**
 * Brand knowledge base editor. Users paste or upload .txt/.md reference docs
 * (brand voice, approved messaging, facts, spokesperson info) that the AI
 * grounds crisis responses in. Collapsed by default to keep the dashboard calm.
 */
const BrandKnowledge: React.FC = () => {
  const { data, mutate } = useApi<{ documents: ShieldDocument[] }>('/api/shield/documents');
  const docs = data?.documents ?? [];

  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [busy, setBusy] = useState(false);
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
    try {
      await fetch('/api/shield/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: draftTitle.trim(), content: draftContent }),
      });
      setDraftTitle('');
      setDraftContent('');
      await mutate();
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (id: string, title: string, content: string) => {
    setBusy(true);
    try {
      await fetch(`/api/shield/documents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content }),
      });
      setEditingId(null);
      await mutate();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/shield/documents/${id}`, { method: 'DELETE' });
      await mutate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="set-hint">
        Facts, approved messaging and voice the AI grounds replies in. Paste text or upload a .txt or .md file.
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

      <div className="row">
        <input
          className="input"
          type="text"
          value={draftTitle}
          onChange={e => setDraftTitle(e.target.value)}
          placeholder="Document title"
          aria-label="Document title"
        />
        <label className="btn sm">
          <Icon name="upload" size={12} /> Upload
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
        placeholder="Paste brand knowledge…"
        rows={4}
        aria-label="Document text"
      />
      <div className="set-actions">
        <button className="btn sm primary" onClick={add} disabled={busy || !draftContent.trim()}>
          Add document
        </button>
        <span className="set-hint mono">{draftContent.length.toLocaleString()} chars</span>
      </div>
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
  onDelete: (id: string) => void;
}> = ({ doc, editing, busy, onEdit, onCancel, onSave, onDelete }) => {
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content);

  if (!editing) {
    return (
      <div className="shield-doc">
        <div className="shield-doc-main">
          <div className="set-label">{doc.title}</div>
          <div className="set-hint mono">{doc.content.length.toLocaleString()} chars</div>
        </div>
        <button className="btn sm ghost" onClick={onEdit} disabled={busy}>Edit</button>
        <button className="btn sm ghost" onClick={() => onDelete(doc.id)} disabled={busy} aria-label={`Delete ${doc.title}`}>
          <Icon name="trash" size={12} />
        </button>
      </div>
    );
  }

  return (
    <div className="shield-doc editing">
      <input className="input" type="text" value={title} onChange={e => setTitle(e.target.value)} aria-label="Document title" />
      <textarea className="input" value={content} onChange={e => setContent(e.target.value)} rows={6} aria-label="Document text" />
      <div className="set-actions">
        <button className="btn sm primary" onClick={() => onSave(doc.id, title.trim() || 'Untitled', content)} disabled={busy}>
          Save
        </button>
        <button className="btn sm ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
};

export default BrandKnowledge;
