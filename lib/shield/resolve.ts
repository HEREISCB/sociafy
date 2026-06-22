/**
 * lib/shield/resolve.ts
 *
 * "Smart" X search resolution. A user can type a brand/org name
 * ("New Delhi Municipal Council Official"), a handle ("@tweetndmc"), or a bare
 * token ("NDMC"). We resolve that to the real X account via user-search, then
 * build a search query that catches mentions of both the handle AND the name —
 * instead of naively searching the literal text (which would miss everything
 * when the user typed the display name rather than the handle).
 *
 * Resolution is cached per input (TTL) so repeat scans don't re-spend a lookup.
 */

import { searchUsers, isConfigured as twitterApiIoConfigured, type XUser } from '../platforms/twitterapi-io';
import { getOpenAI } from '../ai/client';
import { runAgentLoop, webSearchTool } from '../ai/agent-loop';

export interface ResolvedQuery {
  query: string;              // the X search query to run
  handle: string | null;      // resolved @handle (without the @)
  displayName: string | null; // resolved account display name
  summary: string | null;     // short AI/web description of the entity (if found)
  matchedFrom: 'handle' | 'ai-web-search' | 'user-search' | 'raw';
}

const HANDLE_RX = /^@?[A-Za-z0-9_]{1,15}$/;

const quote = (s: string) => `"${s.replace(/"/g, '').trim()}"`;

function buildQuery(terms: Array<string | null>): string {
  const uniq = Array.from(new Set(terms.filter((t): t is string => !!t)));
  return `(${uniq.join(' OR ')}) lang:en -filter:retweets`;
}

/** Choose the most likely account for the input. The API already ranks by
 *  relevance; we additionally prefer an exact handle/name match, then verified,
 *  then follower count. */
function pickBest(users: XUser[], input: string): XUser | null {
  if (users.length === 0) return null;
  const lc = input.toLowerCase().replace(/^@/, '');
  const exact =
    users.find((u) => u.handle.toLowerCase() === lc) ||
    users.find((u) => u.name.toLowerCase() === input.toLowerCase());
  if (exact) return exact;
  return [...users].sort(
    (a, b) => Number(b.verified) - Number(a.verified) || b.followers - a.followers,
  )[0];
}

// ── Resolution cache ──────────────────────────────────────────────────────────
interface CacheEntry { at: number; resolved: ResolvedQuery }
const cache = new Map<string, CacheEntry>();
const TTL_MS = Number(process.env.TWITTERAPI_IO_CACHE_TTL_MS) || 15 * 60 * 1000;

export async function resolveXQuery(input: string): Promise<ResolvedQuery> {
  const trimmed = input.trim();
  const key = trimmed.toLowerCase();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.resolved;

  const resolved = await doResolve(trimmed);
  cache.set(key, { at: Date.now(), resolved });
  return resolved;
}

async function doResolve(trimmed: string): Promise<ResolvedQuery> {
  // Explicit handle (@foo) → trust it, skip the lookup.
  if (trimmed.startsWith('@') && HANDLE_RX.test(trimmed)) {
    const handle = trimmed.slice(1);
    return { query: buildQuery([`@${handle}`]), handle, displayName: null, summary: null, matchedFrom: 'handle' };
  }

  // 1) Smartest: AI web search (when OpenAI is configured). Grounds the handle
  //    in real web results and also returns a short description of the entity.
  if (getOpenAI()) {
    const ai = await resolveWithAI(trimmed).catch(() => null);
    if (ai?.handle && HANDLE_RX.test(ai.handle)) {
      return {
        query: buildQuery([`@${ai.handle}`, quote(ai.officialName ?? ''), quote(trimmed)]),
        handle: ai.handle,
        displayName: ai.officialName ?? null,
        summary: ai.summary ?? null,
        matchedFrom: 'ai-web-search',
      };
    }
  }

  // 2) Resolve via X's own user search, then search mentions of it + its name.
  if (twitterApiIoConfigured()) {
    const best = pickBest(await searchUsers(trimmed), trimmed);
    if (best) {
      return {
        query: buildQuery([`@${best.handle}`, quote(best.name), quote(trimmed)]),
        handle: best.handle,
        displayName: best.name,
        summary: null,
        matchedFrom: 'user-search',
      };
    }
  }

  // 3) Fallback: couldn't resolve — search the literal text (and as a handle if
  //    it looks like one) so we still return something.
  const bare = trimmed.replace(/^@/, '');
  const terms = HANDLE_RX.test(trimmed) ? [`@${bare}`, quote(trimmed)] : [quote(trimmed)];
  return { query: buildQuery(terms), handle: null, displayName: null, summary: null, matchedFrom: 'raw' };
}

/** Use OpenAI's hosted web_search to identify the official X handle + a short
 *  description. Returns null in stub mode (no OpenAI key) or if parsing fails. */
async function resolveWithAI(
  input: string,
): Promise<{ handle: string | null; officialName: string | null; summary: string | null } | null> {
  const result = await runAgentLoop({
    model: 'fast',
    system:
      'You identify the official X (Twitter) account for an organization, person, or brand. ' +
      'Use the web_search tool to verify before answering. Never invent a handle — return null if unsure.',
    user:
      `Find the official X/Twitter handle for: "${input}".\n` +
      'Reply with ONLY strict JSON, no prose, no code fences:\n' +
      '{"handle":"<screen name without @, or null>","officialName":"<official display name or null>","summary":"<one-sentence description or null>"}',
    tools: [webSearchTool()],
    maxSteps: 4,
    maxOutputTokens: 500,
  });
  if (!result) return null;

  const json = stripFences(result.text);
  try {
    const parsed = JSON.parse(json) as { handle?: unknown; officialName?: unknown; summary?: unknown };
    const handleRaw = typeof parsed.handle === 'string' ? parsed.handle.replace(/^@/, '').trim() : '';
    return {
      handle: handleRaw && handleRaw.toLowerCase() !== 'null' ? handleRaw : null,
      officialName: typeof parsed.officialName === 'string' && parsed.officialName !== 'null' ? parsed.officialName : null,
      summary: typeof parsed.summary === 'string' && parsed.summary !== 'null' ? parsed.summary : null,
    };
  } catch {
    return null;
  }
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}
