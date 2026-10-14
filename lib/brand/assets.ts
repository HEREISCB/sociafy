/**
 * Brand-kit uploads (POST /api/media/upload with purpose=brand). The type is
 * decided from the bytes, never from the browser's claimed mime or the file
 * name, and the stored Content-Type is ours. SVGs are sanitized before they
 * are stored, because they are served back as images from our bucket.
 */

const MB = 1024 * 1024;
type Kind = { mime: string; max: number };
const PNG: Kind = { mime: 'image/png', max: 10 * MB };
const JPEG: Kind = { mime: 'image/jpeg', max: 10 * MB };
const WEBP: Kind = { mime: 'image/webp', max: 10 * MB };
const SVG: Kind = { mime: 'image/svg+xml', max: 1 * MB };
const PDF: Kind = { mime: 'application/pdf', max: 25 * MB };
const WOFF2: Kind = { mime: 'font/woff2', max: 5 * MB };
const TTF: Kind = { mime: 'font/ttf', max: 5 * MB };
const OTF: Kind = { mime: 'font/otf', max: 5 * MB };

/** Mime types only the brand kit stores — kept out of the compose media library. */
export const BRAND_ONLY_MIMES = [SVG, PDF, WOFF2, TTF, OTF].map((k) => k.mime);
/** Largest file any brand kind accepts — read no more than this. */
export const BRAND_MAX_BYTES = PDF.max;

const starts = (b: Buffer, sig: number[] | string, at = 0) =>
  (typeof sig === 'string' ? [...Buffer.from(sig, 'latin1')] : sig).every((v, i) => b[at + i] === v);

function sniff(b: Buffer): Kind | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (starts(b, [0xff, 0xd8, 0xff])) return JPEG;
  if (starts(b, 'RIFF') && starts(b, 'WEBP', 8)) return WEBP;
  if (starts(b, '%PDF-')) return PDF;
  if (starts(b, 'wOF2')) return WOFF2;
  if (starts(b, [0x00, 0x01, 0x00, 0x00]) || starts(b, 'true')) return TTF;
  if (starts(b, 'OTTO')) return OTF;
  // SVG is text: no NUL bytes and an <svg root somewhere near the top.
  const head = b.subarray(0, 4096).toString('utf8');
  if (!b.includes(0) && /<svg[\s>]/i.test(head)) return SVG;
  return null;
}

const DANGEROUS_ELEMENTS = 'script|foreignObject|iframe|object|embed|handler|listener|set|animate\\w*|use';

/**
 * Strip anything in an SVG that can run code or reach the network: scripts,
 * foreignObject/iframe/embed, SMIL (can rewrite href to javascript:), <use>
 * (can pull external documents), on* handlers, non-fragment hrefs, external
 * url()/@import in CSS. Then re-check, and reject rather than store anything
 * still suspicious. DOCTYPE/ENTITY is rejected outright (XXE, entity bombs).
 * Returns null when the file must be rejected.
 */
export function sanitizeSvg(src: string): string | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) return null;
  let s = src
    .replace(/<\?xml-stylesheet[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(new RegExp(`<(${DANGEROUS_ELEMENTS})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '')
    .replace(new RegExp(`<(${DANGEROUS_ELEMENTS})\\b[^>]*>`, 'gi'), '')
    // on* handlers, however they're separated from the tag name or quoted.
    .replace(/[\s/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' ')
    // href / xlink:href: keep in-document fragments and inline raster data only.
    .replace(/\s(xlink:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, _ns, v: string) =>
      /^["']?(#|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(v) ? m : '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, 'none');
  s = s.trim();
  const leftover = /<script|<foreignObject|<iframe|<embed|<object|javascript:|vbscript:|data:text\/html|[\s/"']on[a-z]+\s*=/i;
  if (leftover.test(s) || !/<svg[\s>]/i.test(s)) return null;
  return s;
}

export type BrandFile =
  | { ok: true; mime: string; body: Buffer }
  | { ok: false; error: 'unsupported_type' | 'file_too_large' | 'unsafe_svg'; status: number; max?: number };

/** Decide what an uploaded brand file is, enforce its size cap, sanitize SVG. */
export function prepareBrandFile(buf: Buffer): BrandFile {
  const kind = sniff(buf);
  if (!kind) return { ok: false, error: 'unsupported_type', status: 415 };
  if (buf.length > kind.max) return { ok: false, error: 'file_too_large', status: 413, max: kind.max };
  if (kind !== SVG) return { ok: true, mime: kind.mime, body: buf };
  const clean = sanitizeSvg(buf.toString('utf8'));
  if (!clean) return { ok: false, error: 'unsafe_svg', status: 415 };
  return { ok: true, mime: SVG.mime, body: Buffer.from(clean, 'utf8') };
}
