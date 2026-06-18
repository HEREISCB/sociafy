import OpenAI from 'openai';
import { isStubMode } from '../env';

let _client: OpenAI | null = null;

/**
 * Singleton OpenAI client. Returns null when no API key is configured —
 * callers fall through to deterministic stub responses so the app works
 * locally without an OpenAI account.
 */
export function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (_client) return _client;
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
// `image` is the only one that doesn't have a hard-coded fallback we trust
// to remain stable — OpenAI rotates image-gen model names faster than chat
// models. Keep it env-configurable so we never have to ship a code change
// when a new generation drops.
export const MODELS = {
  fast: process.env.OPENAI_MODEL_FAST || 'gpt-5-mini',
  smart: process.env.OPENAI_MODEL || 'gpt-5',
  image: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
} as const;

// Groq — OpenAI-compatible endpoint. Used as fallback when OPENAI_API_KEY
// is absent but GROQ_API_KEY is set. Free tier is generous for shield scripts.
let _groq: OpenAI | null = null;

export function getGroq(): OpenAI | null {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  if (_groq) return _groq;
  _groq = new OpenAI({
    apiKey: key,
    baseURL: 'https://api.groq.com/openai/v1',
  });
  return _groq;
}

export const GROQ_MODELS = {
  fast: 'llama-3.3-70b-versatile',
} as const;
