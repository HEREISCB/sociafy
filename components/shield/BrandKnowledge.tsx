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

  const [open, setOpen] = useState(false);
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

  const totalChars = docs.reduce((n, d) => n + d.content.length, 0);

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--bg-elev)',
        overflow: 'hidden',
      }}
    >
      {/* Header / toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--ink)',
          textAlign: 'left',
        }}
      >
        <Icon name="shield" size={14} />
        <span style={{ fontSize: 14, fontWeight: 500 }}>Brand Knowledge</span>
        <span
          className="mono"
          style={{ fontSize: 9.5, padding: '1px 6px', borderRadius: 100, background: 'var(--bg-sunk)', color: 'var(--ink-3)' }}
        >
          {docs.length} doc{docs.length === 1 ? '' : 's'}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
          {totalChars.toLocaleString()} chars
        </span>
        <Icon name={open ? 'chevron_down' : 'chevron_right'} size={13} />
      </button>

      {open && (
        <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>
            Reference text the AI uses when drafting responses — brand voice, approved messaging, key
            facts, spokesperson details. Paste text or upload a <code>.txt</code>/<code>.md</code> file.
          </p>

          {/* Existing docs */}
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

          {/* Add new */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 12,
              border: '1px dashed var(--line-2)',
              borderRadius: 'var(--r)',
              background: 'var(--bg-sunk)',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                placeholder="Document title (e.g. Brand Voice Guide)"
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 'var(--r-sm)',
                  border: '1px solid var(--line-2)',
                  background: 'var(--bg)',
                  color: 'var(--ink)',
                  fontSize: 13,
                }}
              />
              <label className="btn sm" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <Icon name="upload" size={12} /> Upload
                <input
                  type="file"
                  accept=".txt,.md,.markdown,text/plain,text/markdown"
                  onChange={e => onFile(e.target.files?.[0])}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
            <textarea
              value={draftContent}
              onChange={e => setDraftContent(e.target.value)}
              placeholder="Paste your brand knowledge here…"
              rows={5}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 'var(--r-sm)',
                border: '1px solid var(--line-2)',
                background: 'var(--bg)',
                color: 'var(--ink)',
                fontSize: 13,
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                {draftContent.length.toLocaleString()} chars
              </span>
              <button
                className="btn primary sm"
                onClick={add}
                disabled={busy || !draftContent.trim()}
              >
                <Icon name="plus" size={12} /> Add document
              </button>
            </div>
          </div>
        </div>
      )}
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r)',
          background: 'var(--bg)',
        }}
      >
        <Icon name="book" size={13} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>{doc.title}</div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
            {doc.content.length.toLocaleString()} chars
          </div>
        </div>
        <button className="btn sm" onClick={onEdit} disabled={busy}>Edit</button>
        <button
          className="btn sm"
          onClick={() => onDelete(doc.id)}
          disabled={busy}
          style={{ color: 'oklch(0.55 0.18 25)' }}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: '1px solid var(--accent)',
        borderRadius: 'var(--r)',
        background: 'var(--bg)',
      }}
    >
      <input
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        style={{
          padding: '8px 12px',
          borderRadius: 'var(--r-sm)',
          border: '1px solid var(--line-2)',
          background: 'var(--bg-sunk)',
          color: 'var(--ink)',
          fontSize: 13,
        }}
      />
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        rows={6}
        style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: 'var(--r-sm)',
          border: '1px solid var(--line-2)',
          background: 'var(--bg-sunk)',
          color: 'var(--ink)',
          fontSize: 13,
          resize: 'vertical',
          fontFamily: 'inherit',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          className="btn primary sm"
          onClick={() => onSave(doc.id, title.trim() || 'Untitled', content)}
          disabled={busy}
        >
          Save
        </button>
      </div>
    </div>
  );
};

export default BrandKnowledge;
