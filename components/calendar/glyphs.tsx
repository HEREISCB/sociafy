import { PLATFORM_LABELS, PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';

const LETTER: Record<string, string> = { ig: 'I', fb: 'f', x: 'X', li: 'in', tt: 'T', yt: 'Y', rd: 'r' };

export function Glyphs({ platforms }: { platforms: Platform[] }) {
  return (
    <span className="cal-glyphs" aria-label={platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(', ')}>
      {platforms.map((p) => (
        <span key={p} className={`pglyph ${PLATFORM_TO_SHORT[p]}`} aria-hidden="true">{LETTER[PLATFORM_TO_SHORT[p]]}</span>
      ))}
    </span>
  );
}
