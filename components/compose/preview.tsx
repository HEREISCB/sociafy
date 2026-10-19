'use client';

import React, { useState } from 'react';
import { Pglyph } from '../icons';
import { PLATFORM_LABELS, PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';
import { seekToPoster } from '../../lib/media/motionSeek';
import type { MediaItem } from './attachments';

type Author = { displayName: string | null; handle: string | null; avatarUrl: string | null };
/** A Video post with no clip yet: the frame it will fill. */
export type VideoSlot = { aspect: string; label?: string; durationSec?: number; rendering: boolean };

/** How the post reads on each selected platform: its text, its first posted item (or the video still to come). */
export function Preview({ platforms, textFor, media, authorFor, videoSlot }: {
  platforms: Platform[];
  textFor: (p: Platform) => string;
  /** Only what gets posted (postMedia) — never a Video post's references. */
  media: MediaItem[];
  authorFor: (p: Platform) => Author | undefined;
  videoSlot?: VideoSlot | null;
}) {
  const [picked, setPicked] = useState<Platform | null>(null);
  const p = picked && platforms.includes(picked) ? picked : platforms[0];
  if (!p) return <p className="compose-note">Pick a platform to preview.</p>;
  const a = authorFor(p);
  const name = a?.displayName?.trim() || a?.handle?.trim() || 'You';
  const hero = media.find((m) => m.url && !m.uploading);

  return (
    <div className="stack">
      {platforms.length > 1 && (
        <div className="compose-chips" role="group" aria-label="Preview platform">
          {platforms.map((x) => (
            <button key={x} type="button" className={`prompt-chip${x === p ? ' active' : ''}`} aria-pressed={x === p} onClick={() => setPicked(x)}>
              {PLATFORM_LABELS[x] ?? x}
            </button>
          ))}
        </div>
      )}
      <article className="compose-post">
        <header className="row">
          {a?.avatarUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="compose-post-avatar" src={a.avatarUrl} alt="" referrerPolicy="no-referrer" />
            : <Pglyph p={PLATFORM_TO_SHORT[p]} size="lg" />}
          <div>
            <div className="compose-post-name">{name}</div>
            {a?.handle && <div className="compose-note">@{a.handle}</div>}
          </div>
        </header>
        {textFor(p) && <p className="compose-post-text">{textFor(p)}</p>}
        {hero ? (
          <div className="compose-post-media" style={hero.aspect ? { aspectRatio: hero.aspect } : undefined}>
            {hero.mimeType?.startsWith('video/')
              // A poster is the real still; without one, park on the representative frame.
              ? <video key={hero.url} src={hero.url} poster={hero.posterUrl} controls playsInline preload="metadata" onLoadedMetadata={hero.posterUrl ? undefined : seekToPoster} />
              // eslint-disable-next-line @next/next/no-img-element
              : <img src={hero.url} alt={hero.label} />}
            {media.length > 1 && <span className="badge compose-post-count">1/{media.length}</span>}
          </div>
        ) : videoSlot ? (
          <div className="compose-post-media compose-post-slot" style={{ aspectRatio: videoSlot.aspect.replace(':', '/') }} aria-busy={videoSlot.rendering}>
            <span>{videoSlot.rendering ? 'Rendering video…' : 'Video will appear here after you Generate'}</span>
            {(videoSlot.label || videoSlot.durationSec) && (
              <span className="compose-note">{[videoSlot.label, videoSlot.durationSec && `${videoSlot.durationSec}s`, videoSlot.aspect].filter(Boolean).join(' · ')}</span>
            )}
          </div>
        ) : null}
      </article>
    </div>
  );
}
