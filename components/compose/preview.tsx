'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { Icon, Pglyph } from '../icons';
import { PLATFORM_LABELS, PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';
import { seekToPoster } from '../../lib/media/motionSeek';
import type { MediaItem } from './attachments';
import { RenderPhases, type Render } from './generate';

type Author = { displayName: string | null; handle: string | null; avatarUrl: string | null };
/** A Video post with no clip yet: the frame it will fill. */
export type VideoSlot = { aspect: string; label?: string; durationSec?: number };

/**
 * How the post reads on each selected platform: one tab per platform, its
 * caption (clamped, like the feed does), and a fixed-height media frame that
 * shows the running job's real phases, then "develops" the result.
 */
export function Preview({ platforms, active, onActive, textFor, media, authorFor, videoSlot, job, format, freshId }: {
  platforms: Platform[];
  active: Platform | undefined;
  onActive: (p: Platform) => void;
  textFor: (p: Platform) => string;
  /** Only what gets posted (postMedia) — never a Video post's references. */
  media: MediaItem[];
  authorFor: (p: Platform) => Author | undefined;
  videoSlot?: VideoSlot | null;
  /** The image/video job running now. */
  job: Render | null;
  format: 'text' | 'image' | 'video';
  /** The item generated this session: it develops in, rather than just appearing. */
  freshId: string | null;
}) {
  const [more, setMore] = useState(false);
  const [clamped, setClamped] = useState(false);
  const cap = useRef<HTMLParagraphElement | null>(null);
  const text = active ? textFor(active) : '';
  useLayoutEffect(() => {
    const el = cap.current;
    if (!el || more) return;
    // Measured clamped: only an overflowing caption offers "…more". Re-measured
    // on resize, which includes the phone's Preview pane being shown.
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, more]);

  const a = active ? authorFor(active) : undefined;
  const name = a?.displayName?.trim() || a?.handle?.trim() || 'You';
  const hero = media.find((x) => x.url && !x.uploading);

  return (
    <div className="compose-preview">
      <div className="compose-ptabs" role="tablist" aria-label="Preview platform">
        <AnimatePresence initial={false} mode="popLayout">
          {platforms.map((x) => (
            <m.button
              key={x} layout type="button" role="tab" aria-selected={x === active} className="compose-ptab"
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.28, ease: [0.65, 0, 0.35, 1] }}
              onClick={() => onActive(x)}
            >
              {PLATFORM_LABELS[x] ?? x}
              {x === active && <m.span layoutId="compose-ptab-ind" className="compose-ptab-ind" transition={{ duration: 0.28, ease: [0.65, 0, 0.35, 1] }} />}
            </m.button>
          ))}
        </AnimatePresence>
        {!platforms.length && <span className="compose-note compose-ptab-empty">Pick a platform above to preview it.</span>}
      </div>

      <article className="compose-post" aria-label={active ? `${PLATFORM_LABELS[active] ?? active} preview` : 'Preview'}>
        <header className="compose-post-head">
          {a?.avatarUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="compose-post-avatar" src={a.avatarUrl} alt="" referrerPolicy="no-referrer" />
            : active ? <Pglyph p={PLATFORM_TO_SHORT[active]} size="lg" /> : <span className="compose-post-avatar" />}
          <div>
            <div className="compose-post-name">{name}</div>
            <div className="compose-note">{[active && (PLATFORM_LABELS[active] ?? active), a?.handle && `@${a.handle}`].filter(Boolean).join(' · ') || 'No platform picked'}</div>
          </div>
        </header>
        <p ref={cap} className={`compose-post-text${more ? '' : ' is-clamped'}${text ? '' : ' is-empty'}`}>
          {text || 'Your caption appears here as you type.'}
        </p>
        {(clamped || more) && (
          <button type="button" className="compose-post-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>
            {more ? 'Show less' : '…more'}
          </button>
        )}
        <div className="compose-post-frame" aria-busy={Boolean(job)}>
          {job ? (
            <RenderPhases render={job} />
          ) : hero ? (
            <div key={hero.url} className={`compose-post-art${hero.id && hero.id === freshId ? ' develop' : ''}`}>
              {hero.mimeType?.startsWith('video/')
                // A poster is the real still; without one, park on the representative frame.
                ? <video src={hero.url} poster={hero.posterUrl} controls playsInline preload="metadata" onLoadedMetadata={hero.posterUrl ? undefined : seekToPoster} />
                // eslint-disable-next-line @next/next/no-img-element
                : <img src={hero.url} alt={hero.label} />}
              {media.length > 1 && <span className="badge compose-post-count">1/{media.length}</span>}
            </div>
          ) : (
            <div className="compose-post-empty">
              {format === 'text' ? (
                <span>Text-only post. Switch Format to Image or Video to add media.</span>
              ) : (
                <>
                  <Icon name="sparkle" size={20} aria-hidden="true" />
                  <span>{format === 'image' ? 'Your image develops here after you press Generate.' : 'Your video develops here after you press Generate.'}</span>
                  {videoSlot && (videoSlot.label || videoSlot.durationSec) && (
                    <span className="compose-note">{[videoSlot.label, videoSlot.durationSec && `${videoSlot.durationSec}s`, videoSlot.aspect].filter(Boolean).join(' · ')}</span>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </article>
    </div>
  );
}
