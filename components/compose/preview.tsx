'use client';

import React, { useState } from 'react';
import { Pglyph } from '../icons';
import { PLATFORM_LABELS, PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';
import type { MediaItem } from './attachments';

type Author = { displayName: string | null; handle: string | null; avatarUrl: string | null };

/** How the post reads on each selected platform: its text, its first attachment. */
export function Preview({ platforms, textFor, media, authorFor }: {
  platforms: Platform[];
  textFor: (p: Platform) => string;
  media: MediaItem[];
  authorFor: (p: Platform) => Author | undefined;
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
        {hero && (
          <div className="compose-post-media" style={hero.aspect ? { aspectRatio: hero.aspect } : undefined}>
            {hero.mimeType?.startsWith('video/')
              ? <video src={hero.url} controls playsInline preload="metadata" />
              // eslint-disable-next-line @next/next/no-img-element
              : <img src={hero.url} alt={hero.label} />}
            {media.length > 1 && <span className="badge compose-post-count">1/{media.length}</span>}
          </div>
        )}
      </article>
    </div>
  );
}
