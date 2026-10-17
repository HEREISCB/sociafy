'use client';

import React, { useRef, useState } from 'react';
import { Icon } from '../icons';
import { ThumbImg } from '../thumb-img';

export type MediaItem = {
  id?: string;
  url?: string;
  mimeType?: string;
  label: string;
  uploading?: boolean;
  /** CSS aspect ratio ("9/16") when known — the preview uses it. */
  aspect?: string;
  /** An AI-designed motion graphic — offers Edit. */
  motionAi?: boolean;
  /** A short honest caveat about this item (e.g. audio that couldn't be added). */
  note?: string;
  /** A video's still (media_posters) — shown instead of mounting the video. */
  posterUrl?: string;
};

/** Mirrors the drafts schema cap (lib/validation.ts media .max(20)). */
export const MAX_ATTACHED = 20;
const LIBRARY_PAGE = 40;

type LibraryRow = { id: string; publicUrl: string; mimeType: string; label: string | null; width: number | null; height: number | null; createdAt: string; motionAi?: boolean; posterUrl?: string };

const toItem = (r: LibraryRow): MediaItem => ({
  id: r.id,
  url: r.publicUrl,
  mimeType: r.mimeType,
  label: r.label ?? 'Media',
  aspect: r.width && r.height ? `${r.width}/${r.height}` : undefined,
  ...(r.motionAi ? { motionAi: true } : {}),
  ...(r.posterUrl ? { posterUrl: r.posterUrl } : {}),
});

const isVideo = (m: MediaItem) => Boolean(m.mimeType?.startsWith('video/'));

function Thumb({ m }: { m: MediaItem }) {
  if (!m.url) return <span className="compose-thumb-empty"><Icon name="refresh" size={14} /></span>;
  if (!isVideo(m) || m.posterUrl) return <ThumbImg src={m.posterUrl ?? m.url} alt={m.label} size={96} />;
  // AI motion graphics open on an empty frame; park the thumbnail near the end (where the poster is taken).
  const onMeta = m.motionAi ? (e: React.SyntheticEvent<HTMLVideoElement>) => { const v = e.currentTarget; if (v.duration > 1) v.currentTime = v.duration - 0.8; } : undefined;
  return <video src={m.url} muted playsInline preload="metadata" onLoadedMetadata={onMeta} />;
}

/**
 * The attachment row: Upload · Library · whatever AI buttons the caller adds,
 * then a strip of what is attached. Only `attached` is ever sent with the
 * post; the library is for browsing and picking.
 */
export function Attachments({
  attached,
  onChange,
  onNotice,
  onEdit,
  children,
}: {
  attached: MediaItem[];
  onChange: (next: (cur: MediaItem[]) => MediaItem[]) => void;
  onNotice: (msg: string) => void;
  /** Open the editor for an AI-designed motion graphic. */
  onEdit?: (m: MediaItem) => void;
  children?: React.ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [library, setLibrary] = useState<MediaItem[]>([]);
  const [libMore, setLibMore] = useState(false);
  const [libBusy, setLibBusy] = useState(false);
  const cursor = useRef<string | null>(null);

  const full = attached.length >= MAX_ATTACHED;

  const loadLibrary = async (older: boolean) => {
    setLibBusy(true);
    try {
      const before = older && cursor.current ? `&before=${encodeURIComponent(cursor.current)}` : '';
      const r = await fetch(`/api/media?limit=${LIBRARY_PAGE}${before}`, { credentials: 'include' });
      if (!r.ok) { onNotice('Could not load your library. Try again.'); return; }
      const { items } = (await r.json()) as { items: LibraryRow[] };
      cursor.current = items[items.length - 1]?.createdAt ?? cursor.current;
      setLibMore(items.length === LIBRARY_PAGE);
      setLibrary((cur) => (older ? [...cur, ...items.map(toItem)] : items.map(toItem)));
    } catch {
      onNotice('Could not load your library. Try again.');
    } finally {
      setLibBusy(false);
    }
  };

  const toggleLibrary = () => {
    const next = !libOpen;
    setLibOpen(next);
    if (next) void loadLibrary(false); // refetch so fresh generations show
  };

  const toggle = (m: MediaItem) => {
    if (attached.some((a) => a.id === m.id)) { onChange((cur) => cur.filter((a) => a.id !== m.id)); return; }
    if (full) { onNotice(`Up to ${MAX_ATTACHED} attachments per post.`); return; }
    onChange((cur) => [...cur, m]);
  };

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (full) { onNotice(`Up to ${MAX_ATTACHED} attachments per post.`); return; }
    const tempId = `tmp-${Date.now()}`;
    onChange((cur) => [...cur, { id: tempId, label: file.name, mimeType: file.type, uploading: true }]);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('label', file.name);
      const r = await fetch('/api/media/upload', { method: 'POST', body: fd, credentials: 'include' });
      if (!r.ok) {
        onChange((cur) => cur.filter((a) => a.id !== tempId));
        onNotice(r.status === 413 ? 'That file is too large.' : r.status === 401 ? 'Your session expired — sign in again.' : 'Upload failed. Try again.');
        return;
      }
      const row = (await r.json()) as LibraryRow;
      onChange((cur) => cur.map((a) => (a.id === tempId ? toItem(row) : a)));
    } catch {
      onChange((cur) => cur.filter((a) => a.id !== tempId));
      onNotice('Upload failed. Check your connection and try again.');
    }
  };

  return (
    <>
      {attached.length > 0 && (
        <ul className="compose-strip" aria-label="Attached media">
          {attached.map((m) => (
            <li key={m.id ?? m.label} className="compose-thumb">
              <Thumb m={m} />
              {m.note && <span className="compose-thumb-note" role="note" aria-label={m.note} title={m.note}>!</span>}
              {m.motionAi && m.id && onEdit && (
                <button type="button" className="compose-thumb-edit" aria-label={`Edit ${m.label}`} onClick={() => onEdit(m)}>Edit</button>
              )}
              {!m.uploading && (
                <button type="button" className="compose-thumb-x" aria-label={`Remove ${m.label}`} onClick={() => onChange((cur) => cur.filter((a) => a !== m))}>
                  <Icon name="x" size={10} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="compose-toolbar">
        <button type="button" className="btn ghost sm" onClick={() => fileRef.current?.click()} disabled={full}>
          <Icon name="upload" size={12} /> Upload
        </button>
        <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={upload} />
        <button type="button" className="btn ghost sm" aria-expanded={libOpen} onClick={toggleLibrary}>
          <Icon name="folder" size={12} /> Library
        </button>
        {children}
      </div>

      {libOpen && (
        <div className="compose-library">
          {library.length === 0 && !libBusy && <p className="compose-note">Nothing in your library yet.</p>}
          <div className="compose-library-grid">
            {library.map((m) => {
              const on = attached.some((a) => a.id === m.id);
              return (
                <button key={m.id} type="button" className="compose-thumb" aria-pressed={on} title={m.label} onClick={() => toggle(m)}>
                  <Thumb m={m} />
                  {on && <span className="compose-thumb-check"><Icon name="check" size={10} /></span>}
                </button>
              );
            })}
          </div>
          {libMore && (
            <button type="button" className="btn ghost sm" disabled={libBusy} onClick={() => loadLibrary(true)}>
              {libBusy ? 'Loading…' : 'Load older'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
