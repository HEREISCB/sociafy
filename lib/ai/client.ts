import OpenAI from 'openai';
import { isStubMode } from '../env';

let _client: OpenAI | null = null;

/**
 * Singleton OpenAI client. Returns null when no API key is configured —
 * callers fall through to deterministic stub responses so the app works
 * locally without an OpenAI account.
 */
export function getOpenAI(): OpenAI | null {
  if (isStubMode.ai()) return null;
  if (_client) return _client;
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return _client;
}

/**
 * Backwards-compat shim. Old code calls getAnthropic() — we keep the same
 * boolean semantics (null when no AI configured) so stub fallbacks keep
 * working. The actual client returned is OpenAI now.
 */
export const getAnthropic = getOpenAI;

// Model defaults. Env-overridable so callers can pick a cheaper model if
// they want. Resolved lazily so an unset env var doesn't crash module load.
export const MODELS = {
  fast: process.env.OPENAI_MODEL_FAST || 'gpt-5-mini',
  smart: process.env.OPENAI_MODEL || 'gpt-5',
} as const;
