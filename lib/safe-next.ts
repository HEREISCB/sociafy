/**
 * Sanitize an OAuth/post-action `next` redirect path.
 *
 * We sign the next value into our OAuth state so an attacker can't tamper
 * after the fact, BUT the start route accepts `next` from a query param, so
 * a victim clicking `…/start?next=//evil.com/foo` gets a signed state and
 * the callback would redirect them to `//evil.com/foo`. Validate at sign time.
 *
 * Rules:
 *  - Must start with a single forward slash.
 *  - Must NOT start with `//` or `/\` (protocol-relative / backslash tricks).
 *  - Must NOT contain a colon before any slash (e.g. `javascript:`).
 *  - Length cap to bound state size.
 */
export function safeNextPath(input: string | null | undefined, fallback = '/dashboard'): string {
  if (!input) return fallback;
  if (input.length > 512) return fallback;
  if (!input.startsWith('/')) return fallback;
  if (input.startsWith('//') || input.startsWith('/\\')) return fallback;
  // Strip any embedded NUL or CR/LF that could be used for header injection.
  if (/[\x00\r\n]/.test(input)) return fallback;
  // Reject scheme-like prefixes after the first slash too.
  if (/^\/[a-z]+:\/\//i.test(input)) return fallback;
  return input;
}
