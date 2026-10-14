import { Pglyph } from '../icons';
import { PLATFORM_LABELS, PLATFORM_TO_SHORT } from '../../lib/ui/platforms';
import type { Platform } from '../../lib/db/schema';

export function Glyphs({ platforms }: { platforms: Platform[] }) {
  return (
    <span className="cal-glyphs" role="img" aria-label={platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(', ')}>
      {platforms.map((p) => <Pglyph key={p} p={PLATFORM_TO_SHORT[p]} />)}
    </span>
  );
}
