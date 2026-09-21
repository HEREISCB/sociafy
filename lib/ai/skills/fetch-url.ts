import type { ToolSpec } from '../agent-loop';
import { isPublicHost } from '../../public-host';

const MAX_BYTES = 200_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const UA = 'sociafy-agent/0.1 (+https://sociafy.app)';

/**
 * Lightweight URL fetcher with strict SSRF defenses.
 *
 *  - Only http/https
 *  - Blocks private and loopback IP ranges
 *  - Body capped at 200KB
 *  - 10s timeout
 *  - Strips most HTML tags before returning so the model gets readable content
 */
export const fetchUrlSkill: ToolSpec = {
  type: 'custom',
  def: {
    type: 'function',
    name: 'fetch_url',
    description:
      'Fetch the text content of an HTTPS URL and return it as cleaned plaintext. ' +
      'Useful for reading the full body of an article or post the user mentioned. ' +
      'Returns up to 200KB of text. Strips HTML tags, scripts, and styles.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  handler: async (input) => {
    const page = await fetchPage((input as { url?: string }).url);
    if ('error' in page) return page;
    const cleaned = cleanHtml(page.html);
    return {
      url: page.url,
      contentType: page.contentType,
      bytes: page.bytes,
      text: cleaned.slice(0, 12_000),
      truncated: cleaned.length > 12_000,
    };
  },
};

type FetchedPage =
  | { url: string; contentType: string; bytes: number; html: string }
  | { error: string; detail?: string; contentType?: string };

/**
 * The guarded fetch behind the skill, returning the raw body. Exported so the
 * brand-brief builder shares this one SSRF boundary instead of growing its own.
 *
 * Redirects are followed by hand so every hop is re-checked — `redirect:
 * 'follow'` would let a public URL bounce us to a private host.
 *
 * isPublicHost resolves DNS before judging, so a public name pointing at a
 * private IP is refused too (rebinding caveat documented there).
 */
export async function fetchPage(url: unknown): Promise<FetchedPage> {
  if (!url || typeof url !== 'string') return { error: 'url_required' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'invalid_url' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let resp: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: 'only_http' };
      }
      if (!(await isPublicHost(parsed.hostname))) {
        return { error: 'private_host_blocked' };
      }
      resp = await fetch(parsed.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5',
        },
        signal: controller.signal,
        redirect: 'manual',
      });
      const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null;
      if (!location) break;
      await resp.body?.cancel().catch(() => {});
      parsed = new URL(location, parsed);
      resp = undefined;
    }
    if (!resp) return { error: 'too_many_redirects' };
    if (!resp.ok) return { error: `http_${resp.status}` };
    const ct = resp.headers.get('content-type') ?? 'text/html';
    // Reject obvious binary payloads.
    if (/^(image|video|audio|font|application\/(zip|pdf|octet-stream))/i.test(ct)) {
      return { error: `unsupported_content_type`, contentType: ct };
    }

    // Read into a bounded buffer.
    const reader = resp.body?.getReader();
    if (!reader) return { error: 'no_body' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BYTES) break;
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { url: parsed.toString(), contentType: ct, bytes: total, html: buf.toString('utf8') };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: 'fetch_failed', detail: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
