import { describe, it, expect } from 'vitest';
import { safeNextPath } from './safe-next';

describe('safeNextPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeNextPath('/settings/connections?oauth_error=x')).toBe('/settings/connections?oauth_error=x');
    expect(safeNextPath('/onboarding#step-2')).toBe('/onboarding#step-2');
  });

  it.each([
    ['tab', '/\t/evil.com'],
    ['newline', '/\n/evil.com'],
    ['NUL', '/\x00/evil.com'],
    ['DEL', '/\x7F/evil.com'],
    ['protocol-relative', '//evil.com'],
    ['backslash', '/\\evil.com'],
    ['backslash later', '/a/..\\..\\/evil.com'],
    ['scheme', '/https://evil.com'],
    ['absolute', 'https://evil.com'],
    ['javascript', 'javascript:alert(1)'],
    ['too long', '/' + 'a'.repeat(600)],
  ])('rejects %s', (_, input) => {
    expect(safeNextPath(input, '/fallback')).toBe('/fallback');
  });

  it('leaves percent-encoded slashes as harmless path text', () => {
    // %2F / %5C / %09 are not decoded by the URL parser, so they stay on-origin.
    for (const p of ['/%2F%2Fevil.com', '/%5C%5Cevil.com', '/%09/evil.com']) {
      expect(safeNextPath(p, '/fallback')).toBe(p);
      expect(new URL(p, 'https://app.test').origin).toBe('https://app.test');
    }
  });

  it('falls back on empty input', () => {
    expect(safeNextPath(null)).toBe('/dashboard');
    expect(safeNextPath('')).toBe('/dashboard');
  });
});
