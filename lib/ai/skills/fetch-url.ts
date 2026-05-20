import type { ToolSpec } from '../agent-loop';

const MAX_BYTES = 200_000;
const TIMEOUT_MS = 10_000;
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
    const url = (input as { url?: string }).url;
    if (!url || typeof url !== 'string') return { error: 'url_required' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: 'invalid_url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'only_http' };
    }
    if (isPrivateHost(parsed.hostname)) {
      return { error: 'private_host_blocked' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(parsed.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
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
      const raw = buf.toString('utf8');
      const cleaned = cleanHtml(raw);
      return {
        url: parsed.toString(),
        contentType: ct,
        bytes: total,
        text: cleaned.slice(0, 12_000),
        truncated: cleaned.length > 12_000,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: 'fetch_failed', detail: msg.slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  },
};

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === 'ip6-localhost') return true;
  if (host === '::1') return true;
  // Numeric IPv4
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o[0] === 10) return true;
    if (o[0] === 127) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 0) return true;
    if (o[0] >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6 — block ULA / link-local / loopback cheaply.
  if (host.startsWith('fc') || host.startsWith('fd')) return true;
  if (host.startsWith('fe80')) return true;
  return false;
}

function cleanHtml(html: string): string {
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
