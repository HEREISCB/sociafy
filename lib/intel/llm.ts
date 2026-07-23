/* Shared LLM client: Groq via plain fetch, OpenRouter fallback, md5-keyed
   ai_cache. Single home so every AI caller (summaries, strategist) routes here. */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { aiCache } from '../db/schema';
import { isStubMode } from '../env';

const GROQ_MODEL = process.env.GROQ_TREND_MODEL || 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

type Provider = { url: string; key: string; model: string };

export function provider(): Provider | null {
  if (process.env.GROQ_API_KEY) {
    return { url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: GROQ_MODEL };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return { url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY, model: OPENROUTER_MODEL };
  }
  return null;
}

export function hasProvider(): boolean {
  return provider() !== null;
}

export function hashKey(...parts: (string | number)[]): string {
  return createHash('md5').update(parts.join('|')).digest('hex');
}

export async function call(prompt: string, maxTokens = 300, timeoutMs = 30_000): Promise<string | null> {
  const p = provider();
  if (!p) return null;
  try {
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: p.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Call the model expecting JSON; extracts the first array/object block and parses it. */
export async function callJson<T>(prompt: string, maxTokens = 600, timeoutMs = 30_000): Promise<T | null> {
  const raw = await call(prompt, maxTokens, timeoutMs);
  if (!raw) return null;
  const match = raw.match(/[[{][\s\S]*[\]}]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

export async function cacheGetText(key: string): Promise<string | null> {
  if (isStubMode.database()) return null;
  const [row] = await db().select().from(aiCache).where(eq(aiCache.key, key)).limit(1);
  return (row?.payload as { text?: string } | undefined)?.text ?? null;
}

export async function cacheSetText(key: string, text: string): Promise<void> {
  if (isStubMode.database()) return;
  await db().insert(aiCache)
    .values({ key, payload: { text }, model: provider()?.model ?? null })
    .onConflictDoUpdate({ target: aiCache.key, set: { payload: { text } } });
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  if (isStubMode.database()) return null;
  const [row] = await db().select().from(aiCache).where(eq(aiCache.key, key)).limit(1);
  return (row?.payload as { data?: T } | undefined)?.data ?? null;
}

export async function cacheSetJson<T>(key: string, data: T): Promise<void> {
  if (isStubMode.database()) return;
  await db().insert(aiCache)
    .values({ key, payload: { data } as Record<string, unknown>, model: provider()?.model ?? null })
    .onConflictDoUpdate({ target: aiCache.key, set: { payload: { data } as Record<string, unknown> } });
}
