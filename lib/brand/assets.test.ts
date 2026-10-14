import { describe, expect, it } from 'vitest';
import { prepareBrandFile, sanitizeSvg } from './assets';

const svg = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`;

describe('sanitizeSvg', () => {
  it('keeps an ordinary logo intact', () => {
    const src = svg('<defs><linearGradient id="g"/></defs><style>.a{fill:#f00}</style><path class="a" fill="url(#g)" d="M0 0h10v10z"/>', ' viewBox="0 0 10 10"');
    expect(sanitizeSvg(src)).toBe(src);
  });
  it.each([
    ['script', svg('<script>alert(1)</script><rect/>')],
    ['self-closing script', svg('<script src="https://x/y.js"/><rect/>')],
    ['foreignObject', svg('<foreignObject><iframe src="https://x"></iframe></foreignObject>')],
    ['handler', svg('<rect onclick="alert(1)"/>', ' onload="alert(1)"')],
    ['slash handler', '<svg/onload=alert(1)><rect/></svg>'],
    ['js href', svg('<a href="javascript:alert(1)"><rect/></a>')],
    ['entity-encoded js href', svg('<a xlink:href="java&#x73;cript:alert(1)"><rect/></a>')],
    ['smil', svg('<a><set attributeName="href" to="javascript:alert(1)"/><rect/></a>')],
    ['use', svg('<use href="https://evil/x.svg#a"/>')],
    ['css import', svg('<style>@import url(https://evil/x.css);</style><rect/>')],
    ['external image', svg('<image href="https://tracker/p.png"/>')],
  ])('neutralises %s', (_name, src) => {
    const out = sanitizeSvg(src);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/script|onload|onclick|foreignObject|iframe|<set|<use|@import|https:\/\/(evil|tracker|x)/i);
  });
  it('rejects DOCTYPE/ENTITY outright', () => {
    expect(sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')).toBeNull();
  });
  it('rejects what it cannot clean', () => {
    expect(sanitizeSvg(svg('<rect style="background:url(javascript:alert(1))"/>'))).not.toMatch(/javascript/i);
    expect(sanitizeSvg('<div>not svg</div>')).toBeNull();
  });
});

describe('prepareBrandFile', () => {
  const b = (s: string | number[]) => Buffer.from(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
  it('types files from their bytes', () => {
    expect(prepareBrandFile(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toMatchObject({ ok: true, mime: 'image/png' });
    expect(prepareBrandFile(b('%PDF-1.7 ...'))).toMatchObject({ ok: true, mime: 'application/pdf' });
    expect(prepareBrandFile(b('wOF2....'))).toMatchObject({ ok: true, mime: 'font/woff2' });
    expect(prepareBrandFile(b([0, 1, 0, 0, 0, 9]))).toMatchObject({ ok: true, mime: 'font/ttf' });
    expect(prepareBrandFile(b(svg('<rect/>')))).toMatchObject({ ok: true, mime: 'image/svg+xml' });
  });
  it('rejects unknown types, oversize files and unsafe SVG', () => {
    expect(prepareBrandFile(b('<html><script></script></html>'))).toMatchObject({ ok: false, error: 'unsupported_type' });
    expect(prepareBrandFile(Buffer.concat([b(svg('')), Buffer.alloc(1024 * 1024, 32)]))).toMatchObject({ ok: false, error: 'file_too_large' });
    expect(prepareBrandFile(b('<!DOCTYPE x><svg></svg>'))).toMatchObject({ ok: false, error: 'unsafe_svg' });
  });
  it('stores the sanitized SVG', () => {
    const r = prepareBrandFile(b(svg('<rect onclick="x()"/>')));
    expect(r.ok && r.body.toString()).not.toMatch(/onclick/);
  });
});
